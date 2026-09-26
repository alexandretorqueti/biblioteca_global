import { randomUUID } from 'node:crypto'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { CommandPolicyResolver, type CommandPolicyRepository, type OperationLogger } from '../commands/index.js'
import type { QueueMessage } from '../queue/index.js'
import type { TaskEventSink } from './TaskEventRecorder.js'

export const CANCEL_COMMAND_CODE = 'C04_TASK_CANCEL_REQUESTED'
export const CANCEL_ACTION_CODE = 'A22_CANCEL_TASK'

interface CancelTaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  terminal_status: string | null
}

/**
 * Consumidor governado de cancelamento de tarefas (item 1, incidente 862).
 *
 * Antes desta classe, `TASK_CANCEL_REQUESTED` era despachado pela API e ackado
 * sem nenhum consumidor — o endpoint respondia `{ok:true}` e nada acontecia.
 * O fluxo segue o padrão do DeployConsumer: comando C04 → política P04
 * (`task_not_terminal`) → ação A22 com primitivas auditáveis no
 * `motor_operation_log`:
 *
 * 1. `release_analysis_claim` — libera claim de análise em andamento (a tarefa
 *    deixa de constar como "em execução" para o DELETE);
 * 2. `resolve_task_blockers` — resolve bloqueios ativos (tarefa cancelada não
 *    fica na estação Atenção);
 * 3. `mark_task_cancelled` — grava `terminal_status='cancelled'` em
 *    `task_runtime_facts` (o status derivado passa a retornar `cancelled`);
 * 4. `record_task_event` — trilha imutável em `tarefa_eventos`.
 *
 * As primitivas são idempotentes e a mensagem pode ser reentregue (retry/DLQ)
 * sem efeitos duplicados. Execução fora de transação proposital: cada passo é
 * condicional e uma queda no meio é corrigida pela reentrega.
 *
 * Limitação conhecida: workers de desenvolvimento ativos não são interrompidos
 * (o Scheduler v3 não expõe parada por tarefa); com `MOTOR_RABBITMQ_PREFETCH=1`
 * o consumo é serial e o cancelamento é processado entre execuções.
 */
export class TaskCancelConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: OperationLogger,
    private readonly commandPolicies?: CommandPolicyRepository,
    private readonly taskEvents?: TaskEventSink,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== 'TASK_CANCEL_REQUESTED') return
    const operationId = randomUUID()
    let sequence = 1
    await this.log(operationId, sequence++, 'received', 'executed', message, { commandCode: CANCEL_COMMAND_CODE })

    const task = await this.loadTask(message.taskId)
    if (!task) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { commandCode: CANCEL_COMMAND_CODE, reasonCode: 'task_not_found' })
      return
    }

    const terminal = task.terminal_status !== null
    if (this.commandPolicies) {
      const governed = await this.commandPolicies.findByMessageType(message.type)
      const decision = new CommandPolicyResolver().decide(governed?.command, governed?.policies ?? [], {
        paused: false,
        terminal,
        blocked: false,
        subtaskCount: 0,
        analysisClaimed: false,
      })
      if (decision.kind !== 'execute' || decision.policy.actionCode !== CANCEL_ACTION_CODE) {
        await this.log(operationId, sequence++, 'rejected', 'rejected', message, {
          commandCode: decision.command?.code,
          policyCode: decision.kind === 'execute' ? decision.policy.code : undefined,
          actionCode: decision.kind === 'execute' ? decision.policy.actionCode : undefined,
          reasonCode: decision.kind === 'reject' ? decision.reasonCode : 'unexpected_cancel_action',
        })
        return
      }
      await this.log(operationId, sequence++, 'decision', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
      await this.log(operationId, sequence++, 'action', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
    } else if (terminal) {
      await this.log(operationId, sequence++, 'rejected', 'rejected', message, { commandCode: CANCEL_COMMAND_CODE, reasonCode: 'task_terminal' })
      return
    }

    const ator = typeof message.payload?.ator === 'string' && message.payload.ator.trim() ? message.payload.ator.trim() : 'motor'
    const motivo = typeof message.payload?.motivo === 'string' && message.payload.motivo.trim() ? message.payload.motivo.trim().slice(0, 500) : null

    const [claimResult] = await this.pool.query<ResultSetHeader>(
      `UPDATE task_runtime_facts
       SET analysis_started_at = NULL, analysis_execution_id = NULL, updated_at = NOW()
       WHERE tarefa_id = ? AND analysis_started_at IS NOT NULL`,
      [task.id],
    )
    await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'release_analysis_claim', result: { released: claimResult.affectedRows } })

    const [blockersResult] = await this.pool.query<ResultSetHeader>(
      `UPDATE bloqueios SET resolved_at = NOW() WHERE tarefa_id = ? AND resolved_at IS NULL`,
      [task.id],
    )
    await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'resolve_task_blockers', result: { resolved: blockersResult.affectedRows } })

    await this.pool.query(
      `INSERT INTO task_runtime_facts (tarefa_id, terminal_status, terminal_at, created_at, updated_at)
       VALUES (?, 'cancelled', NOW(), NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         terminal_status = 'cancelled', terminal_at = NOW(),
         analysis_started_at = NULL, analysis_execution_id = NULL,
         clarification_pending_at = NULL, updated_at = NOW()`,
      [task.id],
    )
    await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'mark_task_cancelled', result: { tarefaId: task.id } })

    if (this.taskEvents) {
      await this.taskEvents.record(message.taskId, 'cancelled', ator, {
        motivo,
        claimsReleased: claimResult.affectedRows,
        blockersResolved: blockersResult.affectedRows,
        sourceMessageId: message.messageId,
      })
      await this.log(operationId, sequence++, 'primitive', 'succeeded', message, { primitiveCode: 'record_task_event', result: { evento: 'cancelled', ator } })
    }

    await this.log(operationId, sequence++, 'completed', 'succeeded', message, { actionCode: CANCEL_ACTION_CODE, result: { tarefaId: task.id, motivo } })
    console.log(`[Motor v3] Tarefa cancelada via comando durável: task=${task.external_id ?? task.id} ator=${ator}${motivo ? ` motivo="${motivo}"` : ''}`)
  }

  private async loadTask(taskId: string): Promise<CancelTaskRow | null> {
    const [rows] = await this.pool.query<CancelTaskRow[]>(
      `SELECT t.id, t.external_id, f.terminal_status
       FROM tarefas t
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
       LIMIT 1`,
      [taskId, taskId],
    )
    return rows[0] ?? null
  }

  private async log(operationId: string, sequence: number, phase: 'received' | 'decision' | 'action' | 'primitive' | 'completed' | 'failed' | 'rejected', outcome: 'pending' | 'executed' | 'skipped' | 'rejected' | 'succeeded' | 'failed', message: QueueMessage, extra: Omit<Parameters<OperationLogger['append']>[0], 'operationId' | 'sequence' | 'phase' | 'outcome' | 'messageId' | 'messageType' | 'correlationId' | 'causationId' | 'taskId'> = {}): Promise<void> {
    if (!this.logger) return
    await this.logger.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...extra })
  }
}
