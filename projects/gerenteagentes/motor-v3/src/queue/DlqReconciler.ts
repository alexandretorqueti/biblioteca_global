import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from './QueueMessage.js'
import type { DeadLetterVerdict, DeadLetterVisit } from './RabbitMqTransport.js'

/**
 * DlqReconciler — as filas mortas deixam de ser buraco negro
 * (incidentes 2026-09-25 e 2026-10-29: 73 mensagens mortas em silêncio,
 * entre elas as resoluções do monitor que fechariam os bloqueios 3456/3457).
 *
 * Ciclo (boot + periódico, default 5 min), por DLQ alvo:
 * 1. Drena até `maxPerCyclePerQueue` mensagens via basic.get (visitDeadLetters
 *    do transporte — canal temporário, não interfere no consumo).
 * 2. Classifica cada mensagem contra o estado real do banco:
 *    - TASK_BLOCKED (monitor): bloqueio ainda aberto → recuperável;
 *    - test-gates: job ainda vivo (pending/processing/claimed) → recuperável;
 *    - demais (commands): tarefa existe E tem trabalho ativo (subtarefa
 *      não-final ou bloqueio aberto) → recuperável; senão obsoleta.
 *    Domínios com reconciliador próprio de estado (deploy/analysis/
 *    development/test-gates) toleram o arquivamento: eles reemitem a partir
 *    do banco. O re-enqueue daqui é a via rápida; nunca a única.
 * 3. Recuperável → republica na fila de origem com `dlqRequeueCount+1` no
 *    payload (contador no corpo porque publish() não preserva headers
 *    customizados) e arquiva a decisão em `motor_dlq_archive`.
 *    Obsoleta → arquiva com o motivo. Limite `maxRequeuesPerMessage`:
 *    excedeu → arquiva como `max_dlq_requeues` (sem loop infinito).
 * 4. Erro de infraestrutura na classificação/publicação → mensagem devolvida
 *    à DLQ ('retry') e ciclo interrompido (nada é perdido).
 * 5. Alerta proativo: profundidade total > 0 com crescimento OU cooldown
 *    (default 60 min) vencido → `DlqAlertSender` (Telegram quando
 *    TELEGRAM_BOT_TOKEN+TELEGRAM_DLQ_CHAT_ID configurados; log caso
 *    contrário). Estado do alerta em `motor_dlq_alert_state` (deduplica
 *    entre restarts).
 *
 * Idempotência: consumidores do motor já tratam redelivery (claim/inFlight/
 * FOR UPDATE); re-enqueue duplicado é inócuo. Publicou-e-falhou-ao-arquivar
 * pode duplicar uma mensagem no próximo ciclo — aceitável pela mesma razão.
 */

export type DlqFamily = 'commands' | 'test-gates' | 'monitor'

/** Superfície mínima do transporte usada aqui (RabbitMqTransport satisfaz). */
export interface DlqTransport {
  visitDeadLetters(
    queue: string,
    max: number,
    visitor: (visit: DeadLetterVisit) => Promise<DeadLetterVerdict>,
  ): Promise<{ acked: number; retried: number }>
  publish(queue: string, message: QueueMessage): Promise<void>
  queueDepth(queue: string): Promise<number | null>
}

export interface DlqTarget {
  /** Fila morta (ex.: motor.commands.dlq). */
  dlq: string
  /** Fila de origem para re-enqueue (ex.: motor.commands). */
  origin: string
  family: DlqFamily
  transport: DlqTransport
}

export interface DlqAlertSender {
  send(summary: string): Promise<void>
}

export interface DlqReconcilerConfig {
  pool: Pool
  targets: DlqTarget[]
  maxPerCyclePerQueue?: number
  maxRequeuesPerMessage?: number
  intervalMs?: number
  alertCooldownMinutes?: number
  alertSender?: DlqAlertSender | null
}

export interface DlqCycleSummary {
  requeued: number
  archived: number
  retried: number
  alerted: boolean
  depths: Record<string, number | null>
}

interface ClassifyResult {
  kind: 'recoverable' | 'stale'
  reason: string
  taskId: string | null
  blockId: number | null
}

const ACTIVE_SUBTASK_STATUSES = ['pending', 'running', 'blocked', 'awaiting_clarification', 'analyzing'] as const
const ALIVE_TEST_GATE_STATUSES = ['pending', 'processing', 'claimed'] as const

export class DlqReconciler {
  private timer: NodeJS.Timeout | null = null
  private reconciling = false
  private readonly maxPerCyclePerQueue: number
  private readonly maxRequeuesPerMessage: number
  private readonly intervalMs: number
  private readonly alertCooldownMinutes: number
  private readonly alertSender: DlqAlertSender | null

  constructor(private readonly config: DlqReconcilerConfig) {
    this.maxPerCyclePerQueue = positive(config.maxPerCyclePerQueue, 50)
    this.maxRequeuesPerMessage = positive(config.maxRequeuesPerMessage, 2)
    this.intervalMs = positive(config.intervalMs, 300_000)
    this.alertCooldownMinutes = positive(config.alertCooldownMinutes, 60)
    this.alertSender = config.alertSender ?? null
  }

  async reconcile(): Promise<DlqCycleSummary> {
    const summary: DlqCycleSummary = { requeued: 0, archived: 0, retried: 0, alerted: false, depths: {} }
    if (this.reconciling) return summary
    this.reconciling = true
    this.cycleRequeued = 0
    this.cycleArchived = 0
    try {
      for (const target of this.config.targets) {
        const result = await target.transport.visitDeadLetters(
          target.dlq,
          this.maxPerCyclePerQueue,
          visit => this.visit(target, visit),
        )
        summary.retried += result.retried
      }
      summary.requeued = this.cycleRequeued
      summary.archived = this.cycleArchived
      summary.depths = await this.measureDepths()
      summary.alerted = await this.maybeAlert(summary.depths)
      return summary
    } catch (error) {
      console.error('[DlqReconciler] falha no ciclo:', error instanceof Error ? error.message : error)
      return summary
    } finally {
      this.reconciling = false
    }
  }

  /** Boot: passagem imediata + ciclo periódico (padrão dos reconciliadores). */
  start(): void {
    if (this.timer) return
    void this.reconcile().then(summary => {
      if (summary.requeued + summary.archived > 0) {
        console.log(JSON.stringify({ event: 'dlq_reconciler_boot', ...summary }))
      }
    })
    this.timer = setInterval(() => {
      void this.reconcile().then(summary => {
        if (summary.requeued + summary.archived + summary.retried > 0) {
          console.log(JSON.stringify({ event: 'dlq_reconciler_cycle', ...summary }))
        }
      })
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Contadores do ciclo corrente (reconcile() agrega via visit).
  private cycleRequeued = 0
  private cycleArchived = 0

  private async visit(target: DlqTarget, visit: DeadLetterVisit): Promise<DeadLetterVerdict> {
    const message = visit.message
    const payload = (message.payload ?? {}) as Record<string, unknown>
    const requeueCount = Number(payload.dlqRequeueCount ?? 0)
    if (Number.isFinite(requeueCount) && requeueCount >= this.maxRequeuesPerMessage) {
      await this.archive(target, message, visit.deathCount, requeueCount, 'archived', 'max_dlq_requeues')
      this.cycleArchived += 1
      return 'ack'
    }
    const verdict = await this.classify(target, message, payload)
    if (verdict.kind === 'recoverable') {
      await target.transport.publish(target.origin, {
        ...message,
        payload: {
          ...payload,
          dlqRequeueCount: (Number.isFinite(requeueCount) ? requeueCount : 0) + 1,
          dlqRequeuedAt: new Date().toISOString(),
          dlqOrigin: target.dlq,
        },
      })
      await this.archive(target, message, visit.deathCount, requeueCount + 1, 'requeued', verdict.reason)
      this.cycleRequeued += 1
      return 'ack'
    }
    await this.archive(target, message, visit.deathCount, requeueCount, 'archived', verdict.reason)
    this.cycleArchived += 1
    return 'ack'
  }

  private async classify(target: DlqTarget, message: QueueMessage, payload: Record<string, unknown>): Promise<ClassifyResult> {
    const pool = this.config.pool
    if (message.type === 'TASK_BLOCKED' || target.family === 'monitor') {
      const blockId = Number(payload.blockId ?? 0)
      if (!Number.isInteger(blockId) || blockId <= 0) {
        return { kind: 'stale', reason: 'missing_block_id', taskId: message.taskId ?? null, blockId: null }
      }
      const [rows] = await pool.query<Array<RowDataPacket & { resolved_at: Date | null; tarefa_id: number }>>(
        'SELECT resolved_at, tarefa_id FROM bloqueios WHERE id = ? LIMIT 1',
        [blockId],
      )
      const row = rows[0]
      if (!row) return { kind: 'stale', reason: 'blocker_absent', taskId: message.taskId ?? null, blockId }
      if (row.resolved_at) return { kind: 'stale', reason: 'blocker_resolved', taskId: message.taskId ?? null, blockId }
      return { kind: 'recoverable', reason: 'blocker_open', taskId: message.taskId ?? null, blockId }
    }

    if (target.family === 'test-gates') {
      const jobId = Number(payload.jobId ?? payload.testGateJobId ?? 0)
      if (Number.isInteger(jobId) && jobId > 0) {
        const [rows] = await pool.query<Array<RowDataPacket & { status: string }>>(
          'SELECT status FROM test_gate_jobs WHERE id = ? LIMIT 1',
          [jobId],
        )
        const status = rows[0]?.status ?? null
        if (status && (ALIVE_TEST_GATE_STATUSES as readonly string[]).includes(status)) {
          return { kind: 'recoverable', reason: 'test_gate_job_active', taskId: message.taskId ?? null, blockId: null }
        }
        return { kind: 'stale', reason: status ? `test_gate_job_${status}` : 'test_gate_job_absent', taskId: message.taskId ?? null, blockId: null }
      }
      // Sem jobId: cai na verificação genérica de tarefa.
    }

    // Genérico (commands e resíduos): tarefa existe e tem trabalho ativo?
    const taskId = typeof message.taskId === 'string' && message.taskId.length > 0 ? message.taskId : null
    const databaseTaskId = Number(payload.databaseTaskId ?? 0)
    const [taskRows] = await pool.query<Array<RowDataPacket & { id: number; external_id: string | null }>>(
      `SELECT t.id, t.external_id FROM tarefas t
        WHERE (t.external_id IS NOT NULL AND t.external_id = ?) OR (? > 0 AND t.id = ?)
        LIMIT 1`,
      [taskId ?? '', Number.isInteger(databaseTaskId) ? databaseTaskId : 0, Number.isInteger(databaseTaskId) ? databaseTaskId : 0],
    )
    const task = taskRows[0]
    if (!task) return { kind: 'stale', reason: 'task_absent', taskId, blockId: null }
    const placeholders = ACTIVE_SUBTASK_STATUSES.map(() => '?').join(',')
    const [activeRows] = await pool.query<Array<RowDataPacket & { active_subtasks: number; open_blocker: number }>>(
      `SELECT
         EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = ? AND s.status IN (${placeholders})) AS active_subtasks,
         EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id = ? AND b.resolved_at IS NULL) AS open_blocker`,
      [task.id, ...ACTIVE_SUBTASK_STATUSES, task.id],
    )
    const active = activeRows[0]
    if (Number(active?.active_subtasks) === 1 || Number(active?.open_blocker) === 1) {
      return { kind: 'recoverable', reason: 'task_has_active_work', taskId: task.external_id ?? taskId, blockId: null }
    }
    return { kind: 'stale', reason: 'task_without_active_work', taskId: task.external_id ?? taskId, blockId: null }
  }

  private async archive(
    target: DlqTarget,
    message: QueueMessage,
    deathCount: number,
    requeueCount: number,
    decision: 'requeued' | 'archived',
    reason: string,
  ): Promise<void> {
    let payloadJson: string | null = null
    try {
      const serialized = JSON.stringify(message)
      payloadJson = serialized.length > 60_000 ? `${serialized.slice(0, 60_000)}…` : serialized
    } catch {
      payloadJson = null
    }
    const blockIdRaw = Number((message.payload as Record<string, unknown> | undefined)?.blockId ?? 0)
    await this.config.pool.query(
      `INSERT INTO motor_dlq_archive
         (queue, family, message_type, message_id, task_id, block_id, death_count, requeue_count, decision, reason, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
      [
        target.dlq,
        target.family,
        String(message.type ?? ''),
        String(message.messageId ?? '').slice(0, 120) || null,
        String(message.taskId ?? '').slice(0, 80) || null,
        Number.isInteger(blockIdRaw) && blockIdRaw > 0 ? blockIdRaw : null,
        deathCount,
        requeueCount,
        decision,
        reason.slice(0, 120),
        payloadJson,
      ],
    )
  }

  private async measureDepths(): Promise<Record<string, number | null>> {
    const depths: Record<string, number | null> = {}
    for (const target of this.config.targets) {
      depths[target.dlq] = await target.transport.queueDepth(target.dlq)
    }
    return depths
  }

  private async maybeAlert(depths: Record<string, number | null>): Promise<boolean> {
    if (!this.alertSender) return false
    const total = Object.values(depths).reduce<number>((sum, depth) => sum + (depth ?? 0), 0)
    const pool = this.config.pool
    if (total <= 0) {
      await pool.query(
        `INSERT INTO motor_dlq_alert_state (queue_name, last_depth, last_alert_at, updated_at)
         VALUES ('__total__', 0, NULL, NOW())
         ON DUPLICATE KEY UPDATE last_depth = 0, updated_at = NOW()`,
      )
      return false
    }
    const [rows] = await pool.query<Array<RowDataPacket & { last_depth: number; last_alert_at: Date | null }>>(
      `SELECT last_depth, last_alert_at FROM motor_dlq_alert_state WHERE queue_name = '__total__' LIMIT 1`,
    )
    const state = rows[0]
    const grew = total > Number(state?.last_depth ?? 0)
    const cooldownMs = this.alertCooldownMinutes * 60_000
    const lastAlert = state?.last_alert_at ? new Date(state.last_alert_at).getTime() : 0
    const cooledDown = Date.now() - lastAlert >= cooldownMs
    if (!grew && !cooledDown) return false
    const detail = Object.entries(depths).map(([queue, depth]) => `${queue}=${depth ?? '?'}`).join(' ')
    try {
      await this.alertSender.send(
        `⚠️ DLQs do motor com ${total} mensagem(ns) morta(s): ${detail}. ` +
        `O DlqReconciler tenta re-enfileirar as recuperáveis e arquiva as obsoletas (motor_dlq_archive). ` +
        `Persistindo = investigar causa (RabbitMQ management ou motor_dlq_archive).`,
      )
    } catch (error) {
      console.error('[DlqReconciler] alerta falhou:', error instanceof Error ? error.message : error)
      return false
    }
    await pool.query(
      `INSERT INTO motor_dlq_alert_state (queue_name, last_depth, last_alert_at, updated_at)
       VALUES ('__total__', ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE last_depth = VALUES(last_depth), last_alert_at = NOW(), updated_at = NOW()`,
      [total],
    )
    return true
  }
}

/**
 * Alerta Telegram mínimo (HTTPS direto, sem dependência nova).
 * Sem TELEGRAM_BOT_TOKEN ou TELEGRAM_DLQ_CHAT_ID → no-op com log único
 * (o alerta continua visível em dlq_depth_warning/dlq_reconciler_cycle).
 */
export class TelegramDlqAlertSender implements DlqAlertSender {
  private warnedMissingConfig = false
  constructor(
    private readonly botToken: string | undefined,
    private readonly chatId: string | undefined,
  ) {}

  async send(summary: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true
        console.warn('[DlqReconciler] Telegram não configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_DLQ_CHAT_ID); alerta só em log.')
      }
      console.warn(`[DlqReconciler] alerta DLQ (log-only): ${summary}`)
      return
    }
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: summary, disable_web_page_preview: true }),
    })
    if (!response.ok) {
      throw new Error(`Telegram respondeu ${response.status}`)
    }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}
