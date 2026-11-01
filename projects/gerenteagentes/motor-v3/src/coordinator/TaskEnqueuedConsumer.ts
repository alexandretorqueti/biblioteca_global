import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { OperationLogger } from '../commands/index.js'
import { createQueueMessage, insertOutboxMessage, type QueueMessage } from '../queue/index.js'
import type { TaskEventSink } from './TaskEventRecorder.js'

/** Tipo de comando consumido por este consumidor (contrato estático). */
export const ENQUEUED_COMMAND_TYPE = 'TASK_ENQUEUED'

/**
 * Consumidor idempotente de `TASK_ENQUEUED` (task-p2-1047, subtarefa 3).
 *
 * DECISÃO DOCUMENTADA (uso real, 31/10/2026): o dispatch de `TASK_ENQUEUED`
 * no endpoint `POST /api/motor/task/:id/enqueue` (start.ts) NÃO é órfão por
 * acaso — ele tem uso real em produção: o fluxo de setup de projeto da
 * Biblioteca Global (`gerenteagentes.service.ts`, "Enfileira no motor via
 * /api/motor/task/:id/enqueue (v2 e v3)") cria a tarefa `setup-<slug>` e
 * chama este endpoint esperando que o motor a processe. Sem consumidor, a
 * tarefa de setup ficava inerte para sempre enquanto a API marcava
 * `setupStatus='queued'` — um no-op silencioso do ponto de vista do usuário.
 *
 * Por isso a decisão foi REGISTRAR UM CONSUMIDOR (e não remover o dispatch):
 * o comando é recebido, auditado e convertido para o caminho canônico do v3
 * (`TASK_RESUME_REQUESTED` via outbox durável, reason `task_enqueued`), que
 * já possui todas as guardas explícitas do TaskCoordinator (paused, terminal,
 * plano existente, claim de análise). Regra do projeto: nenhuma mensagem de
 * comando pode ser despachada sem consumidor.
 *
 * Idempotência (redelivery/retry não duplicam efeitos):
 * - ponte de resume: pulada se já existe `TASK_RESUME_REQUESTED` pendente no
 *   `motor_outbox` para a mesma tarefa (padrão `TaskExecutionReconciler`);
 *   duplicatas que escapem (ex.: resume já publicado/consumido) caem nas
 *   guardas explícitas do coordenador — nunca iniciam duas análises;
 * - trilha de auditoria: `motor_operation_log` por entrega + evento
 *   `task_enqueued` em `tarefa_eventos` (alimenta o operational-feed).
 */
export class TaskEnqueuedConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: OperationLogger,
    private readonly taskEvents?: TaskEventSink,
    private readonly destinationQueue = 'motor.commands',
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== ENQUEUED_COMMAND_TYPE) return
    const operationId = randomUUID()
    let sequence = 1
    await this.log(operationId, sequence++, 'received', 'executed', message)

    const task = await this.loadTask(message.taskId)
    if (!task) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { reasonCode: 'task_not_found' })
      return
    }

    const pendingResume = await this.hasPendingResume(task.taskKey)
    if (pendingResume) {
      // Redelivery ou enqueue repetido: o resume canônico já está na fila.
      await this.log(operationId, sequence++, 'completed', 'skipped', message, {
        reasonCode: 'resume_already_pending',
        result: { bridged: false },
      })
      await this.recordEvent(message.taskId, message.messageId, false)
      return
    }

    await this.log(operationId, sequence++, 'decision', 'executed', message, {
      result: { actionCode: 'bridge_to_task_resume', reason: 'task_enqueued' },
    })
    const resume = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED',
      taskId: message.taskId,
      executionId: `enqueued-resume-${message.messageId}`,
      correlationId: message.correlationId ?? message.messageId,
      causationId: message.messageId,
      payload: { reason: 'task_enqueued', sourceMessageId: message.messageId },
    })
    // Falha na inserção do outbox propaga para o QueueConsumer (retry/DLQ):
    // a ponte é o efeito durável deste comando e não pode ser perdida em
    // silêncio.
    await insertOutboxMessage(this.pool, resume, this.destinationQueue)
    await this.log(operationId, sequence++, 'action', 'succeeded', message, {
      primitiveCode: 'bridge_task_enqueued_to_resume',
      result: { resumeMessageId: resume.messageId },
    })
    await this.recordEvent(message.taskId, message.messageId, true)
    console.log(
      `[Motor v3] TASK_ENQUEUED consumido: task=${message.taskId} → TASK_RESUME_REQUESTED (reason=task_enqueued, messageId=${resume.messageId})`,
    )
    await this.log(operationId, sequence++, 'completed', 'executed', message, { result: { bridged: true } })
  }

  /** Chave canônica da tarefa (external_id quando existe, senão id numérico). */
  private async loadTask(taskId: string): Promise<{ taskKey: string } | null> {
    const numeric = /^\d+$/.test(taskId)
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number; external_id: string | null }>>(
      numeric
        ? 'SELECT id, external_id FROM tarefas WHERE external_id = ? OR CAST(id AS CHAR) = ? LIMIT 1'
        : 'SELECT id, external_id FROM tarefas WHERE external_id = ? LIMIT 1',
      numeric ? [taskId, taskId] : [taskId],
    )
    const row = rows[0]
    if (!row) return null
    return { taskKey: String(row.external_id ?? row.id) }
  }

  /**
   * Verifica se já existe `TASK_RESUME_REQUESTED` pendente (não publicado) no
   * outbox para a mesma tarefa — proteção de idempotência contra redelivery.
   */
  private async hasPendingResume(taskKey: string): Promise<boolean> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { total: number | string }>>(
      `SELECT COUNT(*) AS total
         FROM motor_outbox o
        WHERE o.type = 'TASK_RESUME_REQUESTED'
          AND o.status = 'pending'
          AND (
            o.task_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
            OR o.task_id COLLATE utf8mb4_unicode_ci = CAST(
              (SELECT id FROM tarefas WHERE external_id = ? COLLATE utf8mb4_unicode_ci LIMIT 1)
              AS CHAR CHARACTER SET utf8mb4
            ) COLLATE utf8mb4_unicode_ci
          )`,
      [taskKey, taskKey],
    )
    return Number(rows[0]?.total ?? 0) > 0
  }

  /** Auditoria best-effort em `tarefa_eventos` (nunca derruba o consumo). */
  private async recordEvent(taskId: string, messageId: string, bridged: boolean): Promise<void> {
    if (!this.taskEvents) return
    try {
      await this.taskEvents.record(taskId, 'task_enqueued', 'motor', {
        messageId,
        bridged,
        bridgeCommand: bridged ? 'TASK_RESUME_REQUESTED' : null,
        reason: 'task_enqueued',
      })
    } catch (error) {
      console.warn(
        `[TaskEnqueuedConsumer] falha ao registrar evento task_enqueued da tarefa ${taskId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async log(operationId: string, sequence: number, phase: 'received' | 'decision' | 'action' | 'primitive' | 'completed' | 'failed' | 'rejected', outcome: 'pending' | 'executed' | 'skipped' | 'rejected' | 'succeeded' | 'failed', message: QueueMessage, extra: Omit<Parameters<OperationLogger['append']>[0], 'operationId' | 'sequence' | 'phase' | 'outcome' | 'messageId' | 'messageType' | 'correlationId' | 'causationId' | 'taskId'> = {}): Promise<void> {
    if (!this.logger) return
    await this.logger.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...extra })
  }
}
