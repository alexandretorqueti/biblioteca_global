import type { Db } from "../shared/types/infrastructure.js"
import type { ExecutionEvent } from "../shared/types/execution-event.js"

export interface CreateAttemptInput {
  subtaskId: number
  attemptNumber: number
  startedAt: Date
  agentId?: string | null
  model?: string | null
  executionId?: string | null
  workspacePath?: string | null
  baseCommit?: string | null
}

export interface FinishAttemptInput {
  id: number
  finishedAt: Date
  outcome: string
  reworkReason?: string | null
  resultCommit?: string | null
  tokenInput?: number | null
  tokenOutput?: number | null
  costUsd?: number | null
}

export interface GateRunInput {
  attemptId: number
  gateType: string
  command?: string | null
  startedAt: Date
  finishedAt?: Date | null
  durationMs?: number | null
  exitCode?: number | null
  status: string
  failureFingerprint?: string | null
  evidence?: unknown
}

/** Persistência mínima e aditiva do trilho de auditoria do Motor. */
export class ObservabilityRepository {
  constructor(private readonly db: Db) {}

  async createAttempt(input: CreateAttemptInput): Promise<number> {
    const result = await this.db.query(
      `INSERT INTO execution_attempts
       (subtask_id, attempt_number, started_at, agent_id, model, execution_id, workspace_path, base_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.subtaskId, input.attemptNumber, input.startedAt, input.agentId ?? null,
        input.model ?? null, input.executionId ?? null, input.workspacePath ?? null, input.baseCommit ?? null],
    )
    return result.insertId
  }

  async finishAttempt(input: FinishAttemptInput): Promise<void> {
    await this.db.query(
      `UPDATE execution_attempts
       SET finished_at = ?, outcome = ?, rework_reason = ?, result_commit = ?,
           token_input = ?, token_output = ?, cost_usd = ?
       WHERE id = ?`,
      [input.finishedAt, input.outcome, input.reworkReason ?? null, input.resultCommit ?? null,
        input.tokenInput ?? null, input.tokenOutput ?? null, input.costUsd ?? null, input.id],
    )
  }

  async recordEvent(event: ExecutionEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO execution_events
       (event_id, occurred_at, task_id, subtask_id, attempt_id, event_type, from_status,
        to_status, actor_type, agent_id, model, execution_id, workspace_commit, reason_code, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.event_id, event.occurred_at, event.task_id, event.subtask_id, event.attempt_id,
        event.event_type, event.from_status, event.to_status, event.actor_type, event.agent_id,
        event.model, event.execution_id, event.workspace_commit, event.reason_code, event.correlation_id],
    )
  }

  async recordGate(input: GateRunInput): Promise<number> {
    const evidence = sanitizeEvidence(input.evidence)
    const result = await this.db.query(
      `INSERT INTO gate_runs
       (attempt_id, gate_type, command, started_at, finished_at, duration_ms, exit_code,
        status, failure_fingerprint, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.attemptId, input.gateType, sanitizeText(input.command, 1000), input.startedAt,
        input.finishedAt ?? null, input.durationMs ?? null, input.exitCode ?? null, input.status,
        input.failureFingerprint ?? null, evidence === undefined ? null : JSON.stringify(evidence)],
    )
    return result.insertId
  }
}

const MAX_EVIDENCE_BYTES = 8 * 1024

function sanitizeText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null
  return value.replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, maxLength)
}

function sanitizeEvidence(value: unknown): unknown {
  if (value === undefined || value === null) return value
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { return { truncated: true, reason: "unserializable" } }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_EVIDENCE_BYTES) return value
  return { truncated: true, bytes: Buffer.byteLength(serialized, "utf8"), summary: serialized.slice(0, MAX_EVIDENCE_BYTES - 80) }
}
