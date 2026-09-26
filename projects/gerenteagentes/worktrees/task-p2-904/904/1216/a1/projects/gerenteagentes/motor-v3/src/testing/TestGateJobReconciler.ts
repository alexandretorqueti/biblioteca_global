import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/index.js'

interface StaleJobRow extends RowDataPacket {
  id: number
  request_message_id: string | null
  task_external_id: string
  status: string
  updated_at: Date | string
}

export interface TestGateJobReconcilerConfig {
  /** Publica a mensagem no outbox da fila de gates (mesma rota do Orchestrator). */
  enqueue: (message: QueueMessage) => Promise<void>
  /** Janela de obsolescência em minutos; deve casar com a janela de re-claim do TestGateConsumer. */
  staleMinutes?: number
  intervalMs?: number
}

/**
 * Recupera jobs de gate órfãos: `processing`/`pending` sem worker vivo.
 *
 * Cenário coberto: o worker morre (deploy blue-green, crash) com o job em
 * `processing`. A mensagem `TEST_RUN_REQUESTED` original esgota os retries
 * dentro da janela de re-claim (20 min) e vai para a DLQ; sem este
 * reconciliador o job fica órfão para sempre e `isMotorIdle()` nunca mais
 * retorna true, travando o pipeline de deploy.
 *
 * A recuperação é idempotente: reenfileira `TEST_RUN_REQUESTED` e o claim SQL
 * do TestGateConsumer garante que apenas um executor vença (job recém-claimado
 * não é "stale" e sai do escopo da próxima passagem).
 */
export class TestGateJobReconciler {
  private timer: NodeJS.Timeout | null = null
  private readonly staleMinutes: number
  private readonly intervalMs: number

  constructor(
    private readonly pool: Pool,
    private readonly config: TestGateJobReconcilerConfig,
  ) {
    this.staleMinutes = config.staleMinutes ?? 20
    this.intervalMs = config.intervalMs ?? 300_000
  }

  /** Uma passagem: retorna os ids de jobs reenfileirados. Erros não propagam (barreira, como nos demais reconciliadores). */
  async reconcile(): Promise<number[]> {
    try {
      const [rows] = await this.pool.query<StaleJobRow[]>(
        `SELECT j.id, j.request_message_id, j.status, j.updated_at,
                COALESCE(t.external_id, CAST(j.tarefa_id AS CHAR), CONCAT('gate-job-', j.id)) AS task_external_id
           FROM test_gate_jobs j
           LEFT JOIN tarefas t ON t.id = j.tarefa_id
          WHERE (j.status = 'processing' AND j.updated_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE))
             OR (j.status = 'pending' AND j.updated_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE))
          ORDER BY j.id`,
        [this.staleMinutes, this.staleMinutes],
      )
      const recovered: number[] = []
      for (const row of rows) {
        const message = createQueueMessage({
          type: 'TEST_RUN_REQUESTED',
          taskId: row.task_external_id,
          executionId: `gate-recovery-${row.id}-${Date.now()}`,
          correlationId: row.request_message_id ?? undefined,
          payload: { jobId: row.id, recovered: true },
        })
        await this.config.enqueue(message)
        recovered.push(row.id)
        console.warn(`[Motor v3] Gate job órfão reenfileirado: job=${row.id} status=${row.status} task=${row.task_external_id} updated_at=${row.updated_at}`)
      }
      return recovered
    } catch (error) {
      console.error('[TestGateJobReconciler] falha na reconciliação:', error instanceof Error ? error.message : error)
      return []
    }
  }

  start(): void {
    if (this.timer) return
    // `reconcile` já contém barreira de erro; o void explícito evita unhandled rejection.
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}
