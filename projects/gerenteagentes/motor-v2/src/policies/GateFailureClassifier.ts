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
 *
 * Cadeia de modelos (2026-09-04, Alexandre): vem da tabela
 * `project_model_selection` (tipo MONITOR) — a MESMA tabela que a tela de
 * seleção de modelos usa. Sem cadeia padrão/default: projeto sem modelos
 * MONITOR cadastrados → classificador indisponível (fail-open). A tabela
 * antiga `projeto_model_chain` é legado e NÃO deve mais ser consultada.
 */

import type { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import { createLogger } from "../shared/logger.js"
import { ManagedPromptResolver } from "../prompts/ManagedPromptResolver.js"

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
  /** Slug do projeto captado — chave da seleção de modelos MONITOR. */
  projectSlug?: string | null
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
  /** Chave da sessão fixa "Monitoramento Motor". */
  monitorSessionKey: string
  /** Timeout por tentativa de modelo (ms). */
  timeoutMs: number
}

const DEFAULT_CONFIG: GateFailureClassifierConfig = {
  monitorAgentId: "programador-senior",
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
    if (chain.length === 0) {
      const erro = `Sem modelos MONITOR configurados para o projeto ${input.projectSlug || "(sem projeto)"} — classificador indisponível (fail-open)`
      logger.warn(erro)
      return { kind: "unavailable", error: erro }
    }

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

        const embeddedPrompt = buildGateFailurePrompt(input)
        const prompt = this.db ? await new ManagedPromptResolver(this.db).resolve({
          key: "monitor.classificacao_falha_de_gate",
          fallback: embeddedPrompt,
          taskId: String(input.taskId),
          subtaskId: Number(input.subtaskId),
          values: {
            "**IDTAREFA**": input.taskId, "**IDSUBTAREFA**": input.subtaskId,
            "**OCORRENCIAGATE**": input.occurrence, "**TITULOTAREFA**": input.taskTitle,
            "**AGENTEEXECUTOR**": input.agentId, "**REPOSITORIO**": input.repoPath,
            "**TITULOSUBTAREFA**": input.subtaskTitle, "**ESCOPO**": input.subtaskScope ?? input.subtaskTitle,
            "**CRITERIOSACEITE**": input.acceptanceCriteria ?? [], "**MODELOEXECUTOR**": input.model,
            "**INDICEESCADA**": input.modelIndex, "**COMANDOFALHO**": input.command,
            "**ERROTAREFAANTERIOR**": input.errorMessage,
          },
        }) : embeddedPrompt
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
    const projectSlug = typeof input.projectSlug === "string" ? input.projectSlug.trim() : ""
    if (!projectSlug) {
      logger.warn("Classificador sem projectSlug; impossível resolver a cadeia MONITOR")
      return []
    }
    if (!this.db) return []

    try {
      // Fonte oficial: project_model_selection (mesma tabela da tela de
      // seleção de modelos). Decisão 2026-09-04: SEM cadeia padrão — sem
      // MONITOR cadastrado, o classificador fica indisponível (fail-open).
      const result = await this.db.query(
        `SELECT provider, model
         FROM project_model_selection
         WHERE project_slug = ? AND tipo = 'MONITOR' AND enabled = 1
         ORDER BY ordem ASC`,
        [projectSlug]
      )
      // mysql2 retorna [rows, fields], Db retorna { rows }
      const rows = Array.isArray(result) ? (result[0] as Record<string, unknown>[]) : (result.rows ?? [])
      const chain = rows
        .map((row) => {
          const provider = typeof row.provider === "string" ? row.provider.trim() : ""
          const model = typeof row.model === "string" ? row.model.trim() : ""
          return provider && model ? `${provider}/${model}` : ""
        })
        .filter((model) => model.length > 0)
      if (chain.length === 0) {
        logger.warn(`Nenhum modelo MONITOR habilitado para o projeto ${projectSlug} em project_model_selection`)
      }
      return chain
    } catch (error) {
      logger.warn("Falha ao consultar modelos MONITOR do projeto: " + (error instanceof Error ? error.message : String(error)))
      return []
    }
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
