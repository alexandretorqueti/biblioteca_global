import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AnalystConsole, AnalystSession } from '../analysis/ConsoleAnalystRunner.js'
import { classifyMotorError } from '../queue/ErrorTaxonomy.js'
import { parseGenerationReply, type GenerationOutcome } from './GenerationPlanContract.js'
import { ManagedGenerationPromptResolver, type GenerationPromptInput, type GenerationPromptResolver } from './GenerationPromptResolver.js'
import { resolveGenerationModelChain } from './GenerationModelChain.js'
import type { GenerationTransitionNotifier } from './GenerationTelegramNotifier.js'

/**
 * ProjectGenerationWorker — consumidor de `geracoes_projeto` (Geração Macro
 * de tarefas, docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §2/§3.1).
 *
 * DECISÃO (poll vs outbox, permitida pela proposta §3.1): **poll curto
 * periódico** (padrão 15s) sobre a própria tabela. Justificativa: gerações
 * macro são eventos raros e de baixa volumetria (1 por projeto/rodada de
 * revisão); a linha `pending` JÁ É a fila durável (claim atômico com lease
 * na tabela), então não há necessidade de nova fila RabbitMQ/tipo de outbox.
 * Simples e durável: sobrevive a restart (reconciliador devolve órfãos para
 * `pending`) e não perde eventos (nada é removido da tabela).
 *
 * Fluxo por geração claimada:
 *   pending → running (claim + lease, renovada durante a sessão longa)
 *   → sessão do analista com MODELO PAGO (cadeia configurável, §1.6: nunca local)
 *   → contrato §5:
 *      kind='perguntas' → mensagem role='analyst' em projeto_chats +
 *                        status='awaiting_clarification'
 *                        (a volta para 'pending' quando o usuário responde no
 *                        chat JÁ EXISTE na API — adicionarMensagemChatProjeto;
 *                        NÃO reimplementa ANALISTA_INTERATIVO_CHAT.md)
 *      kind='plano'     → plano normalizado em geracoes_projeto.tasks (json) +
 *                        status='awaiting_approval'
 *   → resposta inválida: retentativa limitada (correção na mesma sessão);
 *     esgotada → status='failed' com erro gravado. NUNCA fabrica bloqueio de
 *     tarefa (docs/TAXONOMIA-ERROS-MOTOR.md: bloqueio é exceção e só nasce do
 *     fluxo work de subtarefa).
 *   → erro infra/capacity (banco/Console/rede): libera o claim de volta para
 *     'pending' (retry transparente no próximo ciclo, sem consumir a geração).
 *   → indisponibilidade de modelo: escalonamento para o próximo da cadeia
 *     (padrão isModelUnavailableError da análise); cadeia esgotada → 'failed'.
 *
 * Premissa de instância única (docs/CONCORRENCIA-E-LOCKS-MOTOR.md): guards em
 * memória + claim/lease no banco; todas as transições são condicionadas a
 * `status='running' AND worker_id=?` para não sobrescrever outro dono após
 * recuperação do reconciliador.
 */

export interface GenerationContextRow extends RowDataPacket {
  id: number
  projeto_id: number
  status: string
  briefing: string | null
  feedback: string | null
  worker_id: string | null
  nome: string
  slug: string
  descricao: string | null
  agente_id: string
  repo_path: string | null
}

export interface ProjectGenerationWorkerConfig {
  /** Intervalo do poll curto por gerações pending. */
  pollIntervalMs?: number
  /** TTL do lease; renovado a cada ttl/3 durante a sessão. */
  leaseTtlMs?: number
  /** Timeout total da sessão do analista (espelho da análise). */
  sessionTimeoutMs?: number
  /** Intervalo de poll do status da sessão no Console. */
  sessionPollIntervalMs?: number
  /** Retentativas de contrato na mesma sessão antes de falhar a geração. */
  maxContractCorrections?: number
  workerId?: string
  promptResolver?: GenerationPromptResolver
  modelChainResolver?: () => Promise<string[]>
  catalogoLoader?: () => Promise<string>
  docsLoader?: (context: { repoPath: string | null }) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /**
   * Notificação Telegram das transições awaiting_clarification/awaiting_approval
   * (F2, task-p2-1057). Best-effort: null/ausente = sem notificação; falha do
   * notifier nunca afeta a transição de status.
   */
  notifier?: GenerationTransitionNotifier | null
}

interface ChatRow extends RowDataPacket {
  role: string
  texto: string
}

const CATALOG_FILE = 'docs/CATALOGO-CAPACIDADES-BIBLIOTECA.md'
const CHAT_HISTORY_LIMIT = 200
const ERROR_TEXT_LIMIT = 4000

export class ProjectGenerationWorker {
  private readonly config: Required<Pick<ProjectGenerationWorkerConfig,
    'pollIntervalMs' | 'leaseTtlMs' | 'sessionTimeoutMs' | 'sessionPollIntervalMs' | 'maxContractCorrections' | 'workerId'>>
  private readonly promptResolver: GenerationPromptResolver
  private readonly modelChainResolver: () => Promise<string[]>
  private readonly catalogoLoader: () => Promise<string>
  private readonly docsLoader: (context: { repoPath: string | null }) => Promise<string>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly notifier: GenerationTransitionNotifier | null
  private timer: NodeJS.Timeout | null = null
  /** Guard em memória (instância única): um tick por vez, uma geração por vez. */
  private ticking = false
  private stopped = false

  constructor(
    private readonly pool: Pool,
    private readonly consoleApi: AnalystConsole,
    config: ProjectGenerationWorkerConfig = {},
  ) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? Number(process.env.MOTOR_GENERATION_POLL_INTERVAL_MS || 15_000),
      leaseTtlMs: config.leaseTtlMs ?? Number(process.env.MOTOR_GENERATION_LEASE_TTL_MS || 900_000),
      sessionTimeoutMs: config.sessionTimeoutMs ?? Number(process.env.MOTOR_GENERATION_SESSION_TIMEOUT_MS || 1_500_000),
      sessionPollIntervalMs: config.sessionPollIntervalMs ?? Number(process.env.MOTOR_GENERATION_SESSION_POLL_MS || 5_000),
      maxContractCorrections: config.maxContractCorrections ?? 1,
      workerId: config.workerId ?? `${hostname()}-generation-${process.pid}`,
    }
    this.promptResolver = config.promptResolver ?? new ManagedGenerationPromptResolver(pool)
    this.modelChainResolver = config.modelChainResolver ?? (() => resolveGenerationModelChain(pool))
    this.catalogoLoader = config.catalogoLoader ?? loadCatalogoCapacidades
    this.docsLoader = config.docsLoader ?? loadProjectDocs
    this.sleep = config.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.notifier = config.notifier ?? null
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    // Passagem imediata no boot (gerações pending sobreviventes de restart) +
    // poll curto periódico.
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Um ciclo: claima e processa gerações pending até esgotar (ou parar). */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // Teto de segurança por ciclo (instância única; gerações são raras).
      for (let iteration = 0; iteration < 50 && !this.stopped; iteration += 1) {
        const geracaoId = await this.claimNext()
        if (geracaoId == null) break
        const retryLater = await this.process(geracaoId)
        // Erro transitório devolveu a geracao para 'pending': NÃO re-claimar
        // no mesmo ciclo (loop quente). O próximo poll é o retry com backoff
        // natural (docs/TAXONOMIA-ERROS-MOTOR.md: espera, nunca falha).
        if (retryLater) break
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * Claim atômico com lease (colunas da migration 0098): SELECT do candidato +
   * UPDATE condicional. `affectedRows === 0` = perdeu o claim para outro
   * worker/ciclo — não duplica processamento.
   */
  async claimNext(): Promise<number | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id FROM geracoes_projeto
        WHERE status = 'pending'
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))
        ORDER BY id ASC LIMIT 1`,
    )
    const candidate = rows[0]?.id == null ? null : Number(rows[0].id)
    if (candidate == null) return null
    const leaseSeconds = Math.max(30, Math.ceil(this.config.leaseTtlMs / 1000))
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE geracoes_projeto
          SET status = 'running', worker_id = ?, claimed_at = NOW(),
              lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), updated_at = NOW()
        WHERE id = ? AND status = 'pending'
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW(3))`,
      [this.config.workerId, leaseSeconds, candidate],
    )
    if (result.affectedRows === 0) return null
    return candidate
  }

  /** Retorna true quando a geracao foi devolvida para 'pending' (retry no próximo poll). */
  private async process(geracaoId: number): Promise<boolean> {
    const renewal = this.startLeaseRenewal(geracaoId)
    try {
      const context = await this.loadContext(geracaoId)
      if (!context) {
        console.warn(`[ProjectGenerationWorker] geração ${geracaoId} não encontrada após claim`)
        return false
      }
      if (context.status !== 'running' || context.worker_id !== this.config.workerId) {
        console.warn(`[ProjectGenerationWorker] geração ${geracaoId} não pertence mais a este worker (status=${context.status})`)
        return false
      }
      const promptInput = await this.montarPromptGeracao(context)
      const prompt = await this.promptResolver.resolve(promptInput)
      const outcome = await this.runAnalystSession(geracaoId, context, prompt.text, prompt.contractText)
      await this.persistOutcome(geracaoId, context, outcome)
      return false
    } catch (error) {
      return await this.handleProcessError(geracaoId, error)
    } finally {
      clearInterval(renewal)
    }
  }

  /**
   * Monta as entradas do prompt (§5): <ESPECIFICACAO>/<DESCRICAO> =
   * projetos_captados.descricao nesta fase F1; <CATALOGO_CRUD> = catálogo da
   * biblioteca (caminho do monorepo configurável); <DOCS> = documentação do
   * projeto quando existir; <CHAT> = histórico de projeto_chats; <FEEDBACK> =
   * coluna feedback (rodadas revise).
   */
  async montarPromptGeracao(context: GenerationContextRow): Promise<GenerationPromptInput> {
    const [chatRows] = await this.pool.query<ChatRow[]>(
      `SELECT role, texto FROM projeto_chats
        WHERE projeto_id = ? ORDER BY id ASC LIMIT ?`,
      [context.projeto_id, CHAT_HISTORY_LIMIT],
    )
    const chat = chatRows.length > 0
      ? chatRows.map(row => `[${String(row.role)}] ${String(row.texto)}`).join('\n')
      : 'Sem histórico de clarificação.'
    const descricao = String(context.descricao ?? '').trim() || '(sem descrição capturada)'
    const [catalogoCrud, docs] = await Promise.all([
      this.catalogoLoader(),
      this.docsLoader({ repoPath: context.repo_path == null ? null : String(context.repo_path) }),
    ])
    return {
      nome: String(context.nome ?? ''),
      slug: String(context.slug ?? ''),
      // F1: a especificação completa (F4, Isa estruturada) ainda não existe;
      // a fonte de entrada é a descrição capturada (proposta §8, F1).
      especificacao: descricao,
      descricao,
      catalogoCrud,
      docs,
      chat,
      feedback: String(context.feedback ?? '').trim() || 'Sem feedback de revisão (primeira rodada).',
    }
  }

  private async runAnalystSession(
    geracaoId: number,
    context: GenerationContextRow,
    promptText: string,
    contractText: string,
  ): Promise<GenerationOutcome> {
    const chain = await this.modelChainResolver()
    if (chain.length === 0) {
      throw new Error('model_unavailable_exhausted: nenhum modelo pago configurado para geração macro')
    }
    const agentId = String(context.agente_id || process.env.MOTOR_GENERATION_AGENT_ID || context.slug || 'analista')
    let lastError: Error | null = null

    for (const model of chain) {
      if (this.stopped) throw new Error('generation_worker_stopped: worker parado durante a geração')
      let session: AnalystSession | undefined
      try {
        session = await this.consoleApi.createSession({
          key: `geracao-${geracaoId}-${model}`,
          agentId,
          model,
          metadata: { geracaoId, projetoId: context.projeto_id, phase: 'geracao_macro' },
        })
        await this.pool.query<ResultSetHeader>(
          `UPDATE geracoes_projeto SET session_key = ?, modelo = ?, updated_at = NOW()
            WHERE id = ? AND status = 'running' AND worker_id = ?`,
          [session.sessionKey, model, geracaoId, this.config.workerId],
        )
        await this.consoleApi.sendMessage({ session, message: promptText })
        let content = await this.waitForResponse(session)
        let corrections = 0
        while (true) {
          try {
            return parseGenerationReply(content)
          } catch (parseError) {
            if (corrections >= this.config.maxContractCorrections) throw parseError
            corrections += 1
            await this.consoleApi.sendMessage({
              session,
              message: [
                'Sua resposta anterior violou o contrato de saída. Corrija e responda novamente.',
                `Erro: ${asError(parseError).message}`,
                contractText ? `Contrato obrigatório:\n${contractText}` : '',
                'Responda somente com o JSON único do contrato (forma "plano" ou forma "perguntas").',
              ].filter(Boolean).join('\n'),
            })
            content = await this.waitForResponse(session)
          }
        }
      } catch (error) {
        const failure = asError(error)
        lastError = failure
        if (isModelUnavailableError(failure)) {
          console.warn(`[ProjectGenerationWorker] modelo indisponível na geração ${geracaoId}: model=${model} erro=${failure.message.slice(0, 200)} — escalonando na cadeia`)
          continue
        }
        throw failure
      }
    }
    throw new Error(`model_unavailable_exhausted: cadeia de modelos paga esgotada na geração ${geracaoId} (último erro: ${lastError?.message.slice(0, 300) ?? 'desconhecido'})`)
  }

  private async waitForResponse(session: AnalystSession): Promise<string> {
    const deadline = Date.now() + this.config.sessionTimeoutMs
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('generation_worker_stopped: worker parado aguardando resposta')
      const status = await this.consoleApi.getSessionStatus(session)
      if (status.isFailed) throw new Error(status.error || 'Sessão de geração terminou com falha')
      if (status.isComplete) {
        if (!status.lastResponse || !String(status.lastResponse).trim()) {
          throw new Error('Geração concluiu sem resposta final utilizável')
        }
        return String(status.lastResponse)
      }
      await this.sleep(this.config.sessionPollIntervalMs)
    }
    throw new Error(`Timeout aguardando resposta da geração macro (sessão ${session.sessionKey})`)
  }

  private async persistOutcome(geracaoId: number, context: GenerationContextRow, outcome: GenerationOutcome): Promise<void> {
    if (outcome.kind === 'perguntas') {
      // Mesma semântica de registrarClarificacaoProjeto (API): perguntas no
      // chat do projeto como role='analyst' + geração em awaiting_clarification.
      const linhas: string[] = ['🤔 O analista precisa de esclarecimentos antes de gerar as tarefas.', '']
      if (outcome.resumo) linhas.push(`Entendimento atual: ${outcome.resumo}`, '')
      outcome.perguntas.forEach((pergunta, indice) => linhas.push(`${indice + 1}) ${pergunta}`))
      linhas.push('', 'Responda neste chat para continuar (ex.: "1: resposta; 2: resposta").')
      await this.pool.query<ResultSetHeader>(
        `INSERT INTO projeto_chats (projeto_id, role, texto, created_at) VALUES (?, 'analyst', ?, NOW())`,
        [context.projeto_id, linhas.join('\n')],
      )
      const [result] = await this.pool.query<ResultSetHeader>(
        `UPDATE geracoes_projeto SET status = 'awaiting_clarification', updated_at = NOW()
          WHERE id = ? AND status = 'running' AND worker_id = ?`,
        [geracaoId, this.config.workerId],
      )
      if (result.affectedRows === 0) {
        console.warn(`[ProjectGenerationWorker] geração ${geracaoId} mudou de dono antes da transição awaiting_clarification`)
        return
      }
      console.log(`[ProjectGenerationWorker] geração ${geracaoId}: perguntas registradas no chat do projeto ${context.projeto_id} → awaiting_clarification`)
      await this.notifyTransition(() => this.notifier?.notifyAwaitingClarification({
        nome: String(context.nome ?? ''),
        slug: String(context.slug ?? ''),
        resumo: outcome.resumo ?? null,
        perguntas: outcome.perguntas.length,
      }), geracaoId, 'awaiting_clarification')
      return
    }

    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE geracoes_projeto SET tasks = ?, status = 'awaiting_approval', updated_at = NOW()
        WHERE id = ? AND status = 'running' AND worker_id = ?`,
      [JSON.stringify(outcome.plano), geracaoId, this.config.workerId],
    )
    if (result.affectedRows === 0) {
      console.warn(`[ProjectGenerationWorker] geração ${geracaoId} mudou de dono antes da transição awaiting_approval`)
      return
    }
    console.log(`[ProjectGenerationWorker] geração ${geracaoId}: plano macro gravado (${outcome.plano.tarefas.length} tarefas, ${outcome.plano.requisitos.length} requisitos) → awaiting_approval`)
    await this.notifyTransition(() => this.notifier?.notifyAwaitingApproval({
      nome: String(context.nome ?? ''),
      slug: String(context.slug ?? ''),
      tarefas: outcome.plano.tarefas.length,
      requisitos: outcome.plano.requisitos.length,
    }), geracaoId, 'awaiting_approval')
  }

  /**
   * Disparo best-effort da notificação Telegram APÓS a transição vencedora:
   * qualquer falha (rede/Telegram/notifier defeituoso) é logada e nunca
   * propaga — a transição de status já está persistida e não pode ser
   * revertida por causa da notificação (critério de aceite F2).
   */
  private async notifyTransition(
    notify: () => Promise<void> | undefined,
    geracaoId: number,
    status: string,
  ): Promise<void> {
    try {
      await notify()
    } catch (error) {
      console.warn(`[ProjectGenerationWorker] geração ${geracaoId}: notificação Telegram (${status}) falhou — transição mantida: ${asError(error).message.slice(0, 200)}`)
    }
  }

  /**
   * Tratamento de erro sem fabricar bloqueio (docs/TAXONOMIA-ERROS-MOTOR.md):
   * - infra/capacity → libera o claim (volta a 'pending'; retry transparente
   *   no próximo poll, sem consumir a geração);
   * - work/config/contrato/cadeia esgotada → 'failed' com erro gravado.
   */
  private async handleProcessError(geracaoId: number, error: unknown): Promise<boolean> {
    const failure = asError(error)
    const message = failure.message
    // Shutdown gracioso: devolve para pending (retoma após restart), não falha.
    if (message.startsWith('generation_worker_stopped')) {
      const released = await this.releaseClaim(geracaoId)
      console.warn(`[ProjectGenerationWorker] geração ${geracaoId}: worker parado — claim liberado de volta para pending (released=${released})`)
      return released
    }
    const terminalByPrefix = /^(contract_violation|model_unavailable_exhausted|catalogo_biblioteca_missing|prompt_configuration_missing)/.test(message)
    const kind = classifyMotorError(failure)
    if (!terminalByPrefix && kind !== 'work') {
      const released = await this.releaseClaim(geracaoId)
      console.warn(`[ProjectGenerationWorker] geração ${geracaoId}: erro ${kind} — claim liberado de volta para pending (released=${released}): ${message.slice(0, 300)}`)
      return released
    }
    await this.markFailed(geracaoId, message)
    console.error(`[ProjectGenerationWorker] geração ${geracaoId} → failed: ${message.slice(0, 300)}`)
    return false
  }

  private async markFailed(geracaoId: number, message: string): Promise<void> {
    await this.pool.query<ResultSetHeader>(
      `UPDATE geracoes_projeto
          SET status = 'failed', erro = ?, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = ? AND status = 'running' AND worker_id = ?`,
      [message.slice(0, ERROR_TEXT_LIMIT), geracaoId, this.config.workerId],
    )
  }

  private async releaseClaim(geracaoId: number): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE geracoes_projeto
          SET status = 'pending', worker_id = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE id = ? AND status = 'running' AND worker_id = ?`,
      [geracaoId, this.config.workerId],
    )
    return result.affectedRows > 0
  }

  private startLeaseRenewal(geracaoId: number): NodeJS.Timeout {
    const leaseSeconds = Math.max(30, Math.ceil(this.config.leaseTtlMs / 1000))
    const renewIntervalMs = Math.max(5_000, Math.floor(this.config.leaseTtlMs / 3))
    return setInterval(() => {
      void this.pool.query<ResultSetHeader>(
        `UPDATE geracoes_projeto
            SET lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
          WHERE id = ? AND status = 'running' AND worker_id = ?`,
        [leaseSeconds, geracaoId, this.config.workerId],
      ).then(([result]) => {
        if (result.affectedRows === 0) {
          console.warn(`[ProjectGenerationWorker] geração ${geracaoId}: lease não renovada (perda de posse); reconciliador/outro worker assumiu`)
        }
      }).catch(error => {
        // Renovação é melhor-esforço; erro transitório de banco não derruba a
        // sessão (o lease vigente ainda dá janela; reconciliador é a rede).
        console.warn(`[ProjectGenerationWorker] geração ${geracaoId}: falha ao renovar lease: ${asError(error).message.slice(0, 200)}`)
      })
    }, renewIntervalMs)
  }

  private async loadContext(geracaoId: number): Promise<GenerationContextRow | null> {
    const [rows] = await this.pool.query<GenerationContextRow[]>(
      `SELECT g.id, g.projeto_id, g.status, g.briefing, g.feedback, g.worker_id,
              p.nome, p.slug, p.descricao,
              COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), p.slug, '') AS agente_id,
              mc.repo_path
         FROM geracoes_projeto g
         INNER JOIN projetos_captados p ON p.id = g.projeto_id
         LEFT JOIN agentes a ON a.id = p.agente_id
         LEFT JOIN projeto_motor_config mc ON mc.projeto_id = p.id
        WHERE g.id = ?`,
      [geracaoId],
    )
    return rows[0] ?? null
  }
}

/**
 * <CATALOGO_CRUD>: conteúdo de docs/CATALOGO-CAPACIDADES-BIBLIOTECA.md na
 * raiz do monorepo. Caminho configurável (MOTOR_CATALOGO_CAPACIDADES_PATH);
 * na ausência, resolve a raiz do repo pelos mesmos candidatos do
 * ApplyProjectMigrationsCli. Ausência do arquivo é erro de configuração
 * terminal (o catálogo é entrada obrigatória do plano — §0.1).
 */
export async function loadCatalogoCapacidades(): Promise<string> {
  const explicit = process.env.MOTOR_CATALOGO_CAPACIDADES_PATH
  const candidates = explicit
    ? [explicit]
    : [process.env.MOTOR_REPO_ROOT_CONTAINER, process.env.REPO_PATH, '/data/workspace/projects/codigofonte/biblioteca-global', '/app']
        .filter((candidate): candidate is string => Boolean(candidate))
        .map(candidate => resolve(candidate, CATALOG_FILE))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFile(candidate, 'utf-8')
  }
  throw new Error(`catalogo_biblioteca_missing: ${CATALOG_FILE} não encontrado (candidatos: ${candidates.join(', ')})`)
}

/**
 * <DOCS>: documentação do projeto quando existir. Nesta fase F1 o doc útil é
 * `docs/ESPECIFICACAO.md` no repo do projeto (gravado pelo setup — F3);
 * ausente, declara explicitamente que não há documentação (o analista não
 * deve presumir).
 */
export async function loadProjectDocs(context: { repoPath: string | null }): Promise<string> {
  const repoPath = (context.repoPath ?? '').trim()
  if (!repoPath) return 'Sem documentação técnica do projeto nesta fase.'
  const candidates = [
    resolve(repoPath, 'docs', 'ESPECIFICACAO.md'),
    resolve(repoPath, 'docs', 'ESPEC-CRUD.md'),
  ]
  const parts: string[] = []
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) parts.push(`--- ${candidate} ---\n${await readFile(candidate, 'utf-8')}`)
    } catch { /* doc ilegível não derruba a geração */ }
  }
  return parts.length > 0 ? parts.join('\n\n') : 'Sem documentação técnica do projeto nesta fase.'
}

/**
 * Indisponibilidade de modelo → escalonamento na cadeia (padrão
 * isModelUnavailable do ConsoleAnalystRunner / regra MEMORY 2026-09-10:
 * erros de autenticação/quota/timeout do provedor são model_unavailable).
 */
export function isModelUnavailableError(error: Error): boolean {
  return /(?:401|403|404|429|INVALID_REQUEST|quota|rate.limit|credit|billing|timed?.?out|indispon[ií]vel|model.+not found|model.not.allowed|not.allowed|missing-provider-auth|provider auth|no api key|concluiu sem resposta|sem resposta|empty response|no response)/i.test(error.message)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
