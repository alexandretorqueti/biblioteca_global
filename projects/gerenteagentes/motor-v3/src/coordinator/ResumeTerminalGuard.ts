import type { Pool, RowDataPacket } from 'mysql2/promise'
import { insertDeduplicatedChatMessage } from '../execution/blockerChatAlert.js'
import { RealtimeMutationBoundary } from '../realtime/RealtimeMutationBoundary.js'

export interface ResumeTerminalGuardQueryable {
  query: Pool['query']
}

export interface ResumeTerminalState {
  found: boolean
  terminalStatus: string | null
  subtaskCount: number
}

/**
 * Guarda síncrona do endpoint `POST /api/motor/task/:id/resume`
 * (task-p2-1047, subtarefa 3 — mesma família do caso real task-p6-1029).
 *
 * Antes deste guarda, o endpoint despachava `TASK_RESUME_REQUESTED` para
 * qualquer tarefa e respondia `{ok:true}`. Para tarefa terminal — em especial
 * `terminal_status='completed'` com 0 subtarefas (status derivado `closed`,
 * estação terminal por veredito da análise, sem deploy) — o coordenador
 * apenas emitia `TASK_IGNORED`: o resume era um **no-op silencioso** para o
 * usuário. Espelho do padrão já adotado no cancel (`CancelTerminalGuard`,
 * tarefa 1029): a resposta HTTP é idempotente e explícita sobre o estado
 * terminal, e a rejeição fica gravada em `tarefa_eventos` + chat da tarefa.
 *
 * A inspeção lê o MESMO fato canônico usado pelo TaskCoordinator
 * (`task_runtime_facts.terminal_status` + contagem de `subtarefas`),
 * garantindo que a resposta HTTP e a decisão do consumidor não divergem.
 */
export async function inspectResumeTerminalState(
  pool: ResumeTerminalGuardQueryable,
  taskId: string,
): Promise<ResumeTerminalState> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT f.terminal_status,
            (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count
       FROM tarefas t
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1`,
    [taskId, taskId],
  )
  const row = rows[0]
  if (!row) return { found: false, terminalStatus: null, subtaskCount: 0 }
  const raw = row.terminal_status != null ? String(row.terminal_status).trim().toLowerCase() : ''
  const subtaskCount = Number(row.subtask_count ?? 0)
  return {
    found: true,
    terminalStatus: raw === '' ? null : raw,
    subtaskCount: Number.isInteger(subtaskCount) && subtaskCount > 0 ? subtaskCount : 0,
  }
}

/**
 * Deriva o status legível e o motivo da rejeição de resume para tarefa terminal.
 *
 * `completed` + 0 subtarefas = `closed` (mesma regra do `DerivedTaskStatusResolver`:
 * análise concluída por veredito, estação terminal sem deploy). A distinção
 * importa porque "closed" não é óbvio para o usuário — o motivo explica que a
 * tarefa foi encerrada pela análise e que novo trabalho exige nova tarefa.
 */
export function deriveResumeRejection(terminalStatus: string, subtaskCount: number): {
  derivedStatus: string
  reason: string
} {
  const status = String(terminalStatus ?? '').trim().toLowerCase()
  if (status === 'completed' && subtaskCount <= 0) {
    return {
      derivedStatus: 'closed',
      reason:
        'Tarefa encerrada por veredito da análise (completed sem subtarefas → estação terminal "closed", sem deploy). Não há execução para retomar; para novo trabalho, crie uma nova tarefa.',
    }
  }
  switch (status) {
    case 'completed':
      return {
        derivedStatus: 'completed',
        reason: 'Tarefa já concluída (estado terminal); resume não se aplica. Para mudanças incrementais use o ajuste (adjustment) ou crie uma nova tarefa.',
      }
    case 'cancelled':
      return {
        derivedStatus: 'cancelled',
        reason: 'Tarefa cancelada (estado terminal); resume não se aplica. Crie uma nova tarefa se o trabalho ainda for necessário.',
      }
    case 'failed':
      return {
        derivedStatus: 'failed',
        reason: 'Tarefa em estado terminal "failed"; resume não se aplica. Revise os eventos/bloqueios da tarefa e crie uma nova tarefa se necessário.',
      }
    default:
      return {
        derivedStatus: status || 'terminal',
        reason: `Tarefa em estado terminal (${status || 'desconhecido'}); resume não se aplica.`,
      }
  }
}

/**
 * Resposta idempotente/explicativa para resume de tarefa já terminal.
 * `accepted: false` + `alreadyTerminal: true` permitem que a Biblioteca
 * distinga "comando enfileirado" de "rejeição explícita" sem interpretar
 * texto (mesmo contrato do `buildAlreadyTerminalCancelResponse`).
 */
export function buildAlreadyTerminalResumeResponse(taskId: string, terminalStatus: string, subtaskCount: number): {
  ok: true
  accepted: false
  alreadyTerminal: true
  taskId: string
  terminalStatus: string
  derivedStatus: string
  message: string
} {
  const { derivedStatus, reason } = deriveResumeRejection(terminalStatus, subtaskCount)
  return {
    ok: true,
    accepted: false,
    alreadyTerminal: true,
    taskId,
    terminalStatus,
    derivedStatus,
    message: `Resume rejeitado: ${reason} Nenhum comando foi enfileirado.`,
  }
}

/** Marcador de idempotência da mensagem de chat da rejeição de resume. */
export function resumeRejectionMarker(taskId: string, terminalStatus: string): string {
  return `[motor-v3:resume-rejected:${taskId}:${terminalStatus}]`
}

/** Texto legível da rejeição de resume publicado no chat da tarefa. */
export function buildResumeRejectionChatText(taskId: string, terminalStatus: string, subtaskCount: number): string {
  const { derivedStatus, reason } = deriveResumeRejection(terminalStatus, subtaskCount)
  return [
    '⛔ **Resume rejeitado — tarefa em estado terminal**',
    '',
    `**Tarefa:** ${taskId}`,
    `**Estado terminal:** ${terminalStatus} (status derivado: ${derivedStatus})`,
    `**Motivo:** ${reason}`,
    '',
    resumeRejectionMarker(taskId, terminalStatus),
  ].join('\n').slice(0, 8_000)
}

/**
 * Porta de notificação da rejeição de resume em tarefa terminal. Implementada
 * por `MySqlResumeRejectionNotifier` (produção) e mockada em testes.
 */
export interface ResumeRejectionNotifier {
  notifyResumeRejected(taskId: string, terminalStatus: string, subtaskCount: number): Promise<void>
}

/** Contrato mínimo de pool aceito pela implementação real (facilita testes). */
export type ResumeRejectionPool = Pick<Pool, 'query'> & Partial<Pick<Pool, 'getConnection'>>

/**
 * Notificador real: grava a rejeição de resume como fato auditável —
 * evento `resume_rejected_terminal` em `tarefa_eventos` (origem 'motor',
 * mesmo padrão do `MySqlTaskEventRecorder`) + mensagem legível no chat da
 * tarefa (`tarefa_chats`, INSERT idempotente por marcador, padrão
 * `blockerChatAlert.ts`) + evento realtime do chat em melhor-esforço.
 *
 * Melhor-esforço por construção: falha de auditoria nunca derruba o fluxo
 * principal (a resposta HTTP do guarda e o `TASK_IGNORED` do coordenador já
 * carregam a rejeição explícita).
 */
export class MySqlResumeRejectionNotifier implements ResumeRejectionNotifier {
  constructor(private readonly pool: ResumeRejectionPool) {}

  async notifyResumeRejected(taskId: string, terminalStatus: string, subtaskCount: number): Promise<void> {
    const { derivedStatus, reason } = deriveResumeRejection(terminalStatus, subtaskCount)
    const payload = JSON.stringify({ reasonCode: 'task_terminal', terminalStatus, subtaskCount, derivedStatus, reason })
    try {
      const numeric = /^\d+$/.test(taskId)
      const where = numeric ? 'external_id = ? OR CAST(id AS CHAR) = ?' : 'external_id = ?'
      const params: unknown[] = numeric
        ? ['resume_rejected_terminal', 'motor', payload, taskId, taskId]
        : ['resume_rejected_terminal', 'motor', payload, taskId]
      await this.pool.query(
        `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
         SELECT id, external_id, ?, ?, 'motor', ?, NOW() FROM tarefas
         WHERE ${where}
         LIMIT 1`,
        params,
      )
    } catch (error) {
      console.warn(
        '[ResumeTerminalGuard] falha ao gravar evento resume_rejected_terminal:',
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      const databaseTaskId = await this.resolveDatabaseTaskId(taskId)
      if (databaseTaskId == null) {
        console.warn(`[ResumeTerminalGuard] tarefa ${taskId} não encontrada; rejeição não gravada no chat.`)
        return
      }
      const texto = buildResumeRejectionChatText(taskId, terminalStatus, subtaskCount)
      const marker = resumeRejectionMarker(taskId, terminalStatus)
      const created = await insertDeduplicatedChatMessage(this.pool, databaseTaskId, marker, texto)
      if (!created) return // redelivery/repetição: alerta já existente, deduplicado
      await this.enqueueRealtime(databaseTaskId, created)
    } catch (error) {
      console.warn(
        '[ResumeTerminalGuard] falha ao gravar rejeição no chat da tarefa:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Resolve o id numérico de `tarefas` a partir do taskId externo ou numérico. */
  private async resolveDatabaseTaskId(taskId: string): Promise<number | null> {
    const numeric = /^\d+$/.test(taskId)
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number }>>(
      numeric
        ? 'SELECT id FROM tarefas WHERE external_id = ? OR CAST(id AS CHAR) = ? LIMIT 1'
        : 'SELECT id FROM tarefas WHERE external_id = ? LIMIT 1',
      numeric ? [taskId, taskId] : [taskId],
    )
    const id = Number(rows[0]?.id)
    return Number.isInteger(id) && id > 0 ? id : null
  }

  /** Evento realtime do chat em melhor-esforço (tela acompanha sem reload). */
  private async enqueueRealtime(databaseTaskId: number, message: { id: number; texto: string }): Promise<void> {
    if (typeof this.pool.getConnection !== 'function') return
    try {
      const realtime = new RealtimeMutationBoundary(this.pool as Pool)
      await realtime.enqueueChatMessage(databaseTaskId, {
        id: message.id, role: 'assistant', texto: message.texto,
      })
    } catch {
      // melhor-esforço: realtime não pode derrubar a auditoria
    }
  }
}
