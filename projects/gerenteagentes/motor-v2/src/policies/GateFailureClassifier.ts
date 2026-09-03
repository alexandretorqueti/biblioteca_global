/**
 * GateFailureClassifier — Classificação de causa raiz em falhas de gate
 *
 * MONITORAMENTO MOTOR (adaptado do v1, 2026-08-19): consultado em TODA falha
 * de gate para classificar a causa raiz antes de decidir o fluxo:
 * - agent_can_solve: problema solucionável pelo agente da tarefa → fluxo normal
 * - test_files_issue: causa raiz em arquivos de TESTE → corrigir testes
 * - code_files_issue: causa raiz em arquivos de CÓDIGO → fluxo normal
 * - motor_issue: causa raiz no próprio MOTOR → tarefa para; corrigir motor
 *
 * Se o classificador falhar (timeout/resposta ilegível), fail-open: fluxo
 * normal continua (o monitor nunca trava a execução).
 */

import type { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import { createLogger } from "../shared/logger.js"

/** Interface mínima para consultas SQL (compatível com mysql2 Connection e Db). */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<[unknown[], unknown] | { rows: Record<string, unknown>[] }>
}

const logger = createLogger("GateFailureClassifier")

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type VerdictKind =
  | "agent_can_solve"
  | "test_files_issue"
  | "code_files_issue"
  | "motor_issue"

export interface GateFailureVerdict {
  verdict: VerdictKind
  /** Identificação objetiva da causa raiz (arquivos, comandos, trechos). */
  analysis: string
  /** Correção proposta — obrigatória para motor_issue. */
  solution?: string
}

export interface GateFailureInput {
  taskId: number | string
  subtaskId: number | string
  subtaskTitle: string
  subtaskScope?: string
  acceptanceCriteria?: string[]
  taskTitle: string
  agentId: string
  repoPath: string
  /** Modelo dev que estava executando a subtarefa. */
  model: string
  modelIndex: number
  /** Nº de ocorrências deste erro de gate nesta subtarefa (1 = primeira). */
  occurrence: number
  /** Mensagem de erro do gate (build ou teste). */
  errorMessage: string
  /** Comando que falhou. */
  command: string
}

export type GateFailureOutcome =
  | { kind: "verdict"; verdict: GateFailureVerdict; modelUsed: string }
  | { kind: "unavailable"; error: string }

// ─── Configuração ───────────────────────────────────────────────────────────

export interface GateFailureClassifierConfig {
  /** Agente da sessão fixa "Monitoramento Motor". */
  monitorAgentId: string
  /** Modelo default do monitor (usado se não houver cadeia por projeto). */
  monitorModel: string
  /** Chave da sessão fixa "Monitoramento Motor". */
  monitorSessionKey: string
  /** Timeout por tentativa de modelo (ms). */
  timeoutMs: number
  /** Cadeia de modelos do monitor (fallback se não houver por projeto). */
  monitorChain?: Array<{ model: string }>
}

const DEFAULT_CONFIG: GateFailureClassifierConfig = {
  monitorAgentId: "programador-senior",
  monitorModel: "openai/gpt-5.6-terra",
  monitorSessionKey: "agent:programador-senior:monitor",
  timeoutMs: 240_000, // 4 minutos
}

// ─── Classe ─────────────────────────────────────────────────────────────────

export class GateFailureClassifier {
  private driver: ConsoleAgentRuntimeDriver
  private db: Queryable | null
  private config: GateFailureClassifierConfig

  constructor(
    driver: ConsoleAgentRuntimeDriver,
    db: Queryable | null,
    config: Partial<GateFailureClassifierConfig> = {}
  ) {
    this.driver = driver
    this.db = db
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Classifica a causa raiz da falha de gate consultando a sessão fixa
   * "Monitoramento Motor". Fail-open: se o monitor falhar, retorna unavailable
   * e o fluxo normal continua.
   */
  async classify(input: GateFailureInput): Promise<GateFailureOutcome> {
    let lastError = "cadeia de monitoramento vazia"
    const chain = await this.resolveChain(input)

    for (let tierIndex = 0; tierIndex < chain.length; tierIndex += 1) {
      const model = String(chain[tierIndex] ?? "")
      if (!model) continue

      try {
        logger.info(`Classificando falha de gate com modelo ${model} (degrau ${tierIndex})`, {
          taskId: String(input.taskId),
          subtaskId: String(input.subtaskId),
          occurrence: input.occurrence,
        })

        const sessionKey = this.buildSessionKey(model)
        const session = await this.driver.createSession({
          agentId: this.config.monitorAgentId,
          key: sessionKey,
          label: `monitor:t${input.taskId}:s${input.subtaskId}`,
          model,
        })

        const prompt = buildGateFailurePrompt(input)
        const { runId } = await this.driver.sendMessage({ session, message: prompt })
        const result = await this.driver.waitForRunCompletion(session, runId, {
          absoluteTimeoutMs: this.config.timeoutMs,
        })

        if (result.state !== "final" || !result.content) {
          lastError = `Modelo ${model} falhou: ${result.errorMessage || result.state}`
          logger.warn(lastError)
          continue
        }

        const verdict = parseVerdict(result.content)
        if (!verdict) {
          lastError = `Modelo ${model} retornou resposta ilegível`
          logger.warn(lastError)
          continue
        }

        logger.info(`Veredito do monitor: ${verdict.verdict}`, {
          taskId: String(input.taskId),
          subtaskId: String(input.subtaskId),
          analysis: verdict.analysis.substring(0, 200),
        })

        return { kind: "verdict", verdict, modelUsed: model }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        logger.warn(`Falha ao classificar com modelo ${model}: ${lastError}`)
      }
    }

    logger.error(`Classificador indisponível: ${lastError}`)
    return { kind: "unavailable", error: lastError }
  }

  private async resolveChain(input: GateFailureInput): Promise<string[]> {
    // Tentar cadeia por projeto (se DB disponível)
    if (this.db) {
      try {
        const result = await this.db.query(
          `SELECT pmc.modelo
           FROM projetos_captados pc
           LEFT JOIN projeto_model_chain pmc
             ON pmc.projeto_id = pc.id AND pmc.fase = 'monitor' AND pmc.ativo = 1
           WHERE pc.slug = ?
           ORDER BY pmc.posicao ASC`,
          [input.agentId] // agentId é usado como projectSlug no contexto do monitor
        )
        // mysql2 retorna [rows, fields], Db retorna { rows }
        const rows = Array.isArray(result) ? (result[0] as Record<string, unknown>[]) : (result.rows ?? [])
        if (rows.length > 0) {
          return rows.map((r) => String(r.modelo ?? r))
        }
      } catch (error) {
        logger.warn("Falha ao consultar cadeia de monitor por projeto: " + (error instanceof Error ? error.message : String(error)))
      }
    }

    // Fallback: cadeia configurada ou modelo default
    if (this.config.monitorChain && this.config.monitorChain.length > 0) {
      return this.config.monitorChain.map((m) => m.model)
    }
    return [this.config.monitorModel]
  }

  /**
   * Chave da sessão do monitor. O prefixo de agente da chave PRECISA ser o
   * agente do monitor (config.monitorAgentId) — o gateway recusa createSession
   * quando o agente da chave difere do agentId (erro visto em produção em
   * 2026-09-03: chave montada com o agente da tarefa, ex. biblioteca-global).
   */
  private buildSessionKey(model: string): string {
    const modelSlug = model.split("/").at(-1)?.replace(/[^a-zA-Z0-9.-]/g, "_") ?? "monitor"
    return `agent:${this.config.monitorAgentId}:monitor:${modelSlug}`
  }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

function buildGateFailurePrompt(input: GateFailureInput): string {
  const criteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
      : "- (sem critérios explícitos)"

  const taskId = String(input.taskId)
  const subtaskId = String(input.subtaskId)

  return [
    `[MONITORAMENTO MOTOR] tarefa ${taskId}, subtarefa ${subtaskId} — ocorrência ${input.occurrence} deste erro de gate`,
    "",
    "[TAREFA]",
    `título: ${input.taskTitle}`,
    `agente executor: ${input.agentId}`,
    `repositório do projeto: ${input.repoPath}`,
    "",
    "[SUBTAREFA]",
    `título: ${input.subtaskTitle}`,
    `escopo: ${input.subtaskScope || input.subtaskTitle}`,
    `critérios de aceite:\n${criteria}`,
    "",
    "[MODELO EXECUTOR QUE FALHOU]",
    `${input.model} (degrau ${input.modelIndex} da escada)`,
    "",
    "[COMANDO QUE FALHOU]",
    `\`${input.command}\``,
    "",
    "[MENSAGEM DE ERRO]",
    input.errorMessage.substring(0, 4000),
    "",
    "[SUA MISSÃO — Monitoramento Motor do Gerente de Agentes]",
    "Analise a falha de gate acima e classifique a CAUSA RAIZ com um destes vereditos:",
    '- "agent_can_solve": o problema é solucionável pelo AGENTE DA TAREFA (ex.: implementação incompleta/incorreta no projeto) — o fluxo normal (rework/escala) resolve.',
    '- "test_files_issue": a causa raiz está em arquivos de TESTE do projeto (teste quebrado/obsoleto/mal escrito) — o motor deve corrigir os testes diretamente.',
    '- "code_files_issue": a causa raiz está em arquivos de CÓDIGO do projeto (bug real no projeto) — o fluxo normal resolve.',
    '- "motor_issue": a causa raiz está no próprio MOTOR/infra do GerenteAgentes (orquestração, gate, ambiente do gate, configuração do motor), NÃO no projeto da tarefa — ex.: divergência entre o ambiente de teste do agente e o do gate, bug no motor, dependência ausente no ambiente do motor.',
    "",
    "[REGRAS]",
    "- Responda APENAS com o JSON do veredito (sem texto fora do JSON).",
    '- "analysis": identificação objetiva da causa raiz (arquivos, comandos, trechos de saída relevantes).',
    '- Para "motor_issue", descreva em "solution" a MELHOR correção para o motor (passos concretos).',
    '- Para "test_files_issue", descreva em "solution" quais arquivos de teste precisam ser corrigidos e como.',
    '- Use "motor_issue" apenas com evidência clara de que o problema é do motor — caso contrário, o fluxo normal resolve.',
    '- Formato: {"verdict":"agent_can_solve"|"test_files_issue"|"code_files_issue"|"motor_issue","analysis":"...","solution":"...(obrigatório para motor_issue e test_files_issue)"}',
  ].join("\n")
}

// ─── Parser ─────────────────────────────────────────────────────────────────

function parseVerdict(content: string): GateFailureVerdict | null {
  try {
    // Tentar extrair JSON do conteúdo (pode ter texto antes/depois)
    const jsonMatch = content.match(/\{[\s\S]*"verdict"[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed.verdict || !parsed.analysis) return null

    const validVerdicts: VerdictKind[] = [
      "agent_can_solve",
      "test_files_issue",
      "code_files_issue",
      "motor_issue",
    ]
    if (!validVerdicts.includes(parsed.verdict)) return null

    return {
      verdict: parsed.verdict as VerdictKind,
      analysis: String(parsed.analysis),
      solution: parsed.solution ? String(parsed.solution) : undefined,
    }
  } catch {
    return null
  }
}
