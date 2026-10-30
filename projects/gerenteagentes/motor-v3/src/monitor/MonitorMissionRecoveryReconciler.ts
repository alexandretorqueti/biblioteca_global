import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createTaskBlockedMessage } from './TaskBlockedEvent.js'
import type { QueueMessage } from '../queue/index.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import type { MonitorHumanNotifier } from './HumanNotifier.js'

/**
 * Linha de bloqueio ativo cuja última missão do Monitor morreu sem fechar o
 * ciclo (sem evento terminal após o `monitor_resolution_started` /
 * `monitor_resolution_capacity_waiting`).
 */
interface OrphanMissionRow extends RowDataPacket {
  block_id: number
  tarefa_id: number
  task_id: string
  block_reason: string
  block_command: string | null
  block_excerpt: string | null
  subtarefa_id: number | null
  last_evento: string
  last_at: Date
  started_count: number
}

export interface MonitorMissionRecoveryReconcilerConfig {
  enqueue: (message: QueueMessage) => Promise<void>
  /** Sink de auditoria (tarefa_eventos). Optional: sem ele, só re-enfileira. */
  events?: TaskEventSink
  /** Notificação humana quando as missões se esgotam sem fechar o ciclo. */
  notifier?: MonitorHumanNotifier
  destinationQueue?: string
  /** Intervalo do ciclo periódico. Default: 5 minutos. */
  intervalMs?: number
  /**
   * Carência (minutos) desde o último evento da missão antes de considerá-la
   * órfã. Cobre a janela entre o `started` e o registro em
   * `motor_active_executions`. Default: 5.
   */
  graceMinutes?: number
  /**
   * Máximo de missões (`monitor_resolution_started`) por bloqueio antes de
   * escalar para o humano em vez de re-enfileirar. Default: 3.
   */
  maxMissionsPerBlock?: number
}

/**
 * Recuperador de missões órfãs do Monitor-Resolvedor (incidente 2026-10-29).
 *
 * Problema: o consumidor do monitor faz **ack antes de executar a missão** e o
 * fechamento do ciclo (veredito → `resolved_at` + `TASK_UNBLOCKED`) depende de
 * o processo permanecer vivo até o fim. Quando o container morre no meio
 * (troca blue-green, crash, restart), a correção pode até ter sido commitada
 * pelo agente (git persiste), mas o bloqueio permanece aberto para sempre:
 * - a mensagem já foi ackada → RabbitMQ não reentrega;
 * - `MonitorBlockerReconciler` não reemite (o `processing_state` da mensagem
 *   consumida consta como concluído);
 * - eventos: existe `monitor_resolution_started`, nunca um evento terminal.
 *   Foi exatamente o que aconteceu com os bloqueios 3456/3457 em 29/10: os
 *   fixes `d52d078e` e `013c8ef6` foram deployados, mas as tarefas 1047/1048
 *   continuaram bloqueadas até intervenção manual.
 *
 * Solução (padrão dos reconciliadores de órfãos — TestGateJobReconciler /
 * AnalysisSessionRecoveryReconciler): varredura periódica + boot que detecta
 * "último evento da missão não-terminal e antigo, sem execução monitor viva em
 * `motor_active_executions`" e reemite o `TASK_BLOCKED` do bloqueio.
 *
 * Segurança contra duplicata:
 * - missão VIVA com <10min: a linha não-expirada em `motor_active_executions`
 *   (execution_id `monitor-<blockId>-*`) suprime o re-enqueue;
 * - missão VIVA com >10min (TTL fixo da linha, sem heartbeat): o re-enqueue
 *   acontece, mas o guarda `inFlight` por blockId no `MonitorResolutionConsumer`
 *   (instância única do Motor — mesma premissa documentada em MEMORY.md)
 *   descarta a duplicata sem efeitos;
 * - missão MORTA: `inFlight` morreu com o processo → a nova execução roda e
 *   fecha o ciclo (o agente encontra a correção já mergeada e responde
 *   RESOLVIDO, ou refaz o mínimo necessário).
 *
 * Escalada: após `maxMissionsPerBlock` missões iniciadas sem fechar o ciclo,
 * para de re-enfileirar, registra `monitor_resolution_orphan_exhausted` e
 * notifica o humano no chat da tarefa (deduplicado pelo marker do notifier).
 *
 * O reconciliador respeita `motor.monitor.active` (pausou → não age) e segue o
 * lifecycle start/stop de `MonitorBlockerReconciler`.
 */
export class MonitorMissionRecoveryReconciler {
  private timer: NodeJS.Timeout | null = null
  private reconciling = false
  private readonly intervalMs: number
  private readonly destinationQueue: string
  private readonly graceMinutes: number
  private readonly maxMissionsPerBlock: number

  constructor(
    private readonly pool: Pool,
    private readonly config: MonitorMissionRecoveryReconcilerConfig,
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
    this.destinationQueue = config.destinationQueue ?? 'motor.monitor'
    this.graceMinutes = Number.isFinite(config.graceMinutes) && (config.graceMinutes as number) > 0
      ? (config.graceMinutes as number)
      : 5
    this.maxMissionsPerBlock = Number.isFinite(config.maxMissionsPerBlock) && (config.maxMissionsPerBlock as number) > 0
      ? (config.maxMissionsPerBlock as number)
      : 3
  }

  /** Uma passagem é segura para repetir e não atua enquanto o Monitor está pausado. */
  async reconcile(): Promise<number> {
    if (this.reconciling) return 0
    this.reconciling = true
    try {
      const [activeRows] = await this.pool.query<Array<RowDataPacket & { valor: boolean | number | string | null }>>(
        `SELECT valor FROM motor_configuracoes WHERE chave = 'motor.monitor.active' LIMIT 1`,
      )
      if (!isActive(activeRows[0]?.valor)) return 0

      // Missões órfãs: bloqueio aberto cujo último evento de missão é
      // started/capacity_waiting antigo, sem execução monitor viva, e sem
      // escalada já registrada (o exhausted sai do conjunto por não ser
      // evento retomável).
      const [rows] = await this.pool.query<OrphanMissionRow[]>(
        `SELECT b.id AS block_id, b.tarefa_id,
                COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id,
                b.block_reason, b.block_command, b.block_excerpt, b.subtarefa_id,
                agg.last_evento, agg.last_at, agg.started_count
           FROM bloqueios b
          INNER JOIN tarefas t ON t.id = b.tarefa_id
          INNER JOIN (
                SELECT e.tarefa_id,
                       JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.blockId')) AS block_key,
                       SUBSTRING_INDEX(GROUP_CONCAT(e.evento ORDER BY e.created_at DESC, e.id DESC SEPARATOR ','), ',', 1) AS last_evento,
                       MAX(e.created_at) AS last_at,
                       COALESCE(SUM(e.evento = 'monitor_resolution_started'), 0) AS started_count
                  FROM tarefa_eventos e
                 WHERE e.evento IN (
                         'monitor_resolution_started',
                         'monitor_resolution_capacity_waiting',
                         'monitor_resolution_requeued',
                         'monitor_resolution_finished',
                         'monitor_resolution_unblocked',
                         'monitor_resolution_skipped',
                         'monitor_resolution_failed',
                         'monitor_resolution_orphan_exhausted')
                   AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.blockId')) IS NOT NULL
                 GROUP BY e.tarefa_id, block_key
               ) agg ON agg.tarefa_id = b.tarefa_id AND agg.block_key = CAST(b.id AS CHAR)
          WHERE b.resolved_at IS NULL
            AND agg.last_evento IN ('monitor_resolution_started', 'monitor_resolution_capacity_waiting')
            AND agg.last_at < NOW() - INTERVAL ? MINUTE
            AND NOT EXISTS (
                  SELECT 1 FROM motor_active_executions mae
                   WHERE mae.phase = 'monitor'
                     AND mae.execution_id LIKE CONCAT('monitor-', b.id, '-%')
                     AND mae.expires_at > NOW())
          ORDER BY b.id`,
        [this.graceMinutes],
      )

      let requeued = 0
      for (const row of rows) {
        const blockId = Number(row.block_id)
        if (Number(row.started_count) >= this.maxMissionsPerBlock) {
          await this.safeRecord(row.task_id, 'monitor_resolution_orphan_exhausted', {
            blockId,
            blockReason: String(row.block_reason ?? ''),
            startedCount: Number(row.started_count),
            maxMissionsPerBlock: this.maxMissionsPerBlock,
          })
          await this.safeNotify(row.task_id, String(row.block_reason ?? ''), blockId)
          continue
        }
        await this.config.enqueue(createTaskBlockedMessage({
          taskId: row.task_id,
          executionId: `monitor-mission-recovery-${blockId}-${Date.now()}`,
          payload: {
            blockId,
            databaseTaskId: Number(row.tarefa_id),
            blockReason: String(row.block_reason ?? ''),
            blockCommand: row.block_command,
            blockExcerpt: row.block_excerpt,
            subtaskId: row.subtarefa_id == null ? null : Number(row.subtarefa_id),
            resumeReason: 'monitor_mission_recovery',
          },
        }))
        // O evento `requeued` vira o último evento da missão e suprime novos
        // re-enqueues até o consumidor registrar um novo started/terminal.
        await this.safeRecord(row.task_id, 'monitor_resolution_requeued', {
          blockId,
          startedCount: Number(row.started_count),
          lastEvento: String(row.last_evento ?? ''),
          lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : String(row.last_at ?? ''),
        })
        requeued += 1
      }
      return requeued
    } catch (error) {
      console.error('[MonitorMissionRecoveryReconciler] falha na reconciliação:', error instanceof Error ? error.message : error)
      return 0
    } finally {
      this.reconciling = false
    }
  }

  /** Boot: uma passagem imediata + ciclo periódico (padrão TestGateJobReconciler). */
  start(): void {
    if (this.timer) return
    void this.reconcile()
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async safeRecord(taskId: string, evento: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.config.events?.record(taskId, evento, 'motor', payload)
    } catch (error) {
      console.warn(`[MonitorMissionRecoveryReconciler] falha ao registrar ${evento}:`, error instanceof Error ? error.message : error)
    }
  }

  private async safeNotify(taskId: string, blockReason: string, blockId: number): Promise<void> {
    try {
      await this.config.notifier?.notify({
        taskId,
        blockReason,
        blockId,
        summary: `O Monitor tentou resolver este bloqueio ${this.maxMissionsPerBlock} vezes e as missões morreram sem fechar o ciclo (troca de container/crash ou falha repetida). O bloqueio permanece aberto e precisa de intervenção humana — revisar o histórico da missão e resolver manualmente pelo Mapa de agentes.`,
      })
    } catch (error) {
      console.warn('[MonitorMissionRecoveryReconciler] falha ao notificar humano:', error instanceof Error ? error.message : error)
    }
  }
}

function isActive(value: boolean | number | string | null | undefined): boolean {
  if (value == null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return value === 'true' || value === '1'
}
