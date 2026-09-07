import { createHash, randomUUID } from "node:crypto"
import type { Db } from "../shared/types/infrastructure.js"

export type AttemptOutcome = "succeeded" | "rejected" | "blocked" | "cancelled" | "system_error"
export type GateStatus = "passed" | "failed" | "skipped" | "error"

export interface AttemptInput {
  subtaskId: number
  attemptNumber: number
  agentId?: string
  model?: string
  executionId?: string
  workspacePath?: string
  baseCommit?: string
}

export interface EventInput {
  taskId?: number
  subtaskId?: number
  attemptId?: number
  eventType: string
  fromStatus?: string
  toStatus?: string
  actorType: string
  agentId?: string
  model?: string
  executionId?: string
  workspaceCommit?: string
  reasonCode?: string
  correlationId: string
  occurredAt?: Date
}

export interface GateInput {
  attemptId: number
  gateType: string
  command?: string
  startedAt?: Date
  finishedAt?: Date
  exitCode?: number
  status: GateStatus
  evidence?: unknown
  failureFingerprint?: string
}

/** Persistência auditável e aditiva do ciclo de execução do Motor. */
export class ExecutionPersistenceService {
  constructor(private readonly db: Db) {}

  async createAttempt(input: AttemptInput): Promise<number> {
    const result = await this.db.query(
      `INSERT INTO execution_attempts
       (subtask_id, attempt_number, agent_id, model, execution_id, workspace_path, base_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.subtaskId, input.attemptNumber, input.agentId ?? null, input.model ?? null,
        input.executionId ?? null, input.workspacePath ?? null, input.baseCommit ?? null]
    )
    return result.insertId
  }

  async finishAttempt(id: number, outcome: AttemptOutcome, data: {
    reworkReason?: string
    resultCommit?: string
    tokenInput?: number
    tokenOutput?: number
    costUsd?: number
  } = {}): Promise<void> {
    await this.db.query(
      `UPDATE execution_attempts
       SET finished_at = NOW(), outcome = ?, rework_reason = ?, result_commit = ?,
           token_input = ?, token_output = ?, cost_usd = ?
       WHERE id = ?`,
      [outcome, data.reworkReason ?? null, data.resultCommit ?? null, data.tokenInput ?? null,
        data.tokenOutput ?? null, data.costUsd ?? null, id]
    )
  }

  async recordEvent(input: EventInput): Promise<string> {
    const eventId = randomUUID()
    await this.db.query(
      `INSERT INTO execution_events
       (event_id, occurred_at, task_id, subtask_id, attempt_id, event_type, from_status,
        to_status, actor_type, agent_id, model, execution_id, workspace_commit,
        reason_code, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, input.occurredAt ?? new Date(), input.taskId ?? null, input.subtaskId ?? null,
        input.attemptId ?? null, input.eventType, input.fromStatus ?? null, input.toStatus ?? null,
        input.actorType, input.agentId ?? null, input.model ?? null, input.executionId ?? null,
        input.workspaceCommit ?? null, input.reasonCode ?? null, input.correlationId]
    )
    return eventId
  }

  async recordGate(input: GateInput): Promise<number> {
    const started = input.startedAt ?? new Date()
    const finished = input.finishedAt
    const durationMs = finished ? Math.max(0, finished.getTime() - started.getTime()) : null
    const evidence = input.evidence === undefined ? null : JSON.stringify(limitEvidence(input.evidence))
    const fingerprint = input.failureFingerprint ?? (input.status === "passed" ? null : fingerprintFor(input.evidence))
    const result = await this.db.query(
      `INSERT INTO gate_runs
       (attempt_id, gate_type, command, started_at, finished_at, duration_ms, exit_code,
        status, failure_fingerprint, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.attemptId, input.gateType, input.command ?? null, started, finished ?? null,
        durationMs, input.exitCode ?? null, input.status, fingerprint, evidence]
    )
    return result.insertId
  }

  async openBlock(input: { taskId: number; subtaskId?: number; reason: string; category?: string; severity?: string; ownerId?: string; rootCause?: string; recurrenceFingerprint?: string }): Promise<number> {
    const result = await this.db.query(
      `INSERT INTO bloqueios
       (tarefa_id, subtarefa_id, block_reason, category, severity, owner_id, root_cause, recurrence_fingerprint, blocked_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'open')`,
      [input.taskId, input.subtaskId ?? null, input.reason, input.category ?? null, input.severity ?? null,
        input.ownerId ?? null, input.rootCause ?? null, input.recurrenceFingerprint ?? null]
    )
    return result.insertId
  }

  async resolveBlock(id: number, resolution: string, status: "resolved" | "cancelled" = "resolved"): Promise<void> {
    await this.db.query(
      `UPDATE bloqueios SET status = ?, resolution = ?, resolved_at = NOW() WHERE id = ? AND status = 'open'`,
      [status, resolution, id]
    )
  }

  async updatePlanning(table: "tarefas" | "subtarefas", id: number, data: {
    weight?: number; plannedStart?: Date; plannedEnd?: Date; estimatedEffortMinutes?: number;
    priority?: number; criticalPath?: boolean; baselineVersion?: string
  }): Promise<void> {
    const fields: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown) => { if (value !== undefined) { fields.push(`${column} = ?`); values.push(value) } }
    add("weight", data.weight); add("planned_start", data.plannedStart); add("planned_end", data.plannedEnd)
    add("estimated_effort_minutes", data.estimatedEffortMinutes); add("priority", data.priority)
    add("critical_path", data.criticalPath); add("baseline_version", data.baselineVersion)
    if (fields.length === 0) return
    values.push(id)
    await this.db.query(`UPDATE ${table} SET ${fields.join(", ")} WHERE id = ?`, values)
  }

  async recordDeploy(subtaskId: number, data: { deployedAt?: Date; smokeTestAt?: Date; smokeTestOk?: boolean; rollbackAt?: Date; incidentId?: string; customerImpact?: boolean }): Promise<void> {
    await this.db.query(
      `UPDATE subtarefas SET deployed_at = ?, smoke_test_at = ?, smoke_test_ok = ?, rollback_at = ?, incident_id = ?, customer_impact = ? WHERE id = ?`,
      [data.deployedAt ?? null, data.smokeTestAt ?? null, data.smokeTestOk ?? null, data.rollbackAt ?? null,
        data.incidentId ?? null, data.customerImpact ?? null, subtaskId]
    )
  }
}

function limitEvidence(value: unknown): unknown {
  const serialized = JSON.stringify(value) ?? String(value)
  if (serialized.length <= 16_384) return value
  return { truncated: true, sha256: createHash("sha256").update(serialized).digest("hex"), bytes: serialized.length }
}

function fingerprintFor(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return createHash("sha256").update(JSON.stringify(value) ?? String(value)).digest("hex")
}
