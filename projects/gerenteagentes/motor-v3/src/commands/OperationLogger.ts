import type { Pool } from 'mysql2/promise'

export type OperationPhase = 'received' | 'decision' | 'action' | 'primitive' | 'completed' | 'failed' | 'rejected'
export type OperationOutcome = 'pending' | 'executed' | 'skipped' | 'rejected' | 'succeeded' | 'failed'

export interface OperationLogEntry {
  operationId: string
  sequence: number
  phase: OperationPhase
  outcome: OperationOutcome
  messageId: string
  messageType: string
  correlationId?: string
  causationId?: string
  taskId?: string
  subtaskId?: number
  commandCode?: string
  policyCode?: string
  policyVersion?: number
  actionCode?: string
  actionSnapshot?: Record<string, unknown>
  primitiveCode?: string
  input?: Record<string, unknown>
  result?: Record<string, unknown>
  reasonCode?: string
  durationMs?: number
}

export interface OperationLogger {
  append(entry: OperationLogEntry): Promise<void>
}

/** Persistência append-only da timeline operacional. */
export class MySqlOperationLogger implements OperationLogger {
  constructor(private readonly pool: Pool) {}

  async append(entry: OperationLogEntry): Promise<void> {
    await this.pool.execute(
      `INSERT INTO motor_operation_log (
        operation_id, sequence, phase, outcome, message_id, message_type,
        correlation_id, causation_id, tarefa_id, subtarefa_id, command_code,
        policy_code, policy_version, action_code, action_snapshot_json,
        primitive_code, input_json, result_json, reason_code, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.operationId, entry.sequence, entry.phase, entry.outcome,
        entry.messageId, entry.messageType, entry.correlationId ?? null,
        entry.causationId ?? null, entry.taskId ?? null, entry.subtaskId ?? null,
        entry.commandCode ?? null, entry.policyCode ?? null, entry.policyVersion ?? null,
        entry.actionCode ?? null, entry.actionSnapshot ? JSON.stringify(entry.actionSnapshot) : null,
        entry.primitiveCode ?? null, entry.input ? JSON.stringify(entry.input) : null,
        entry.result ? JSON.stringify(entry.result) : null, entry.reasonCode ?? null,
        entry.durationMs ?? null,
      ],
    )
  }
}
