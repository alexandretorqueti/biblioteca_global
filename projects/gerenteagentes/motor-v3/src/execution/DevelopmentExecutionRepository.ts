import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/QueueMessage.js'

export interface ReservedSubtask {
  message: QueueMessage<{ subtaskId: number; seq: number; title: string; scope: string }>
  subtaskId: number
  seq: number
}

/** A tarefa permanece em fila; uma liberação de capacidade publicará novo gatilho. */
export interface CapacityWaiting {
  kind: 'capacity_waiting'
  reason: 'global_limit' | 'project_limit'
}

export type ReserveNextSubtaskResult = ReservedSubtask | CapacityWaiting | null

export interface SubtaskExecutionContext {
  taskId: string
  databaseTaskId: number
  projectId: number
  subtaskId: number
  seq: number
  taskTitle: string
  taskDescription: string
  title: string
  scope: string
  acceptanceCriteria: string[]
  deliverables: string[]
  projectSlug: string
  repoPath: string
  baseBranch: string
  buildCommand: string
  testCommand: string
  agentId: string
  workspacePath: string | null
  workspaceBranch: string | null
  workspaceBaseCommit: string | null
  completionKind: string | null
}

interface TaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  projeto_id: number
}

interface SubtaskRow extends RowDataPacket {
  id: number
  seq: number
  titulo: string
  scope: string | null
}

interface ExecutionRow extends RowDataPacket {
  database_task_id: number
  project_id: number
  external_id: string | null
  task_title: string
  task_description: string | null
  subtask_id: number
  seq: number
  subtask_title: string
  scope: string | null
  acceptance_criteria: string | null
  deliverables: string | null
  project_slug: string | null
  repo_path: string | null
  branch_trabalho: string | null
  build_command: string | null
  unit_test_command: string | null
  agent_id: string | null
  workspace_path: string | null
  workspace_branch: string | null
  workspace_base_commit: string | null
  completion_kind: string | null
}

interface MotorLimitRow extends RowDataPacket {
  chave: string
  limite: number | string | null
}

interface ActiveDevelopmentCountRow extends RowDataPacket {
  total: number | string
}

/**
 * Reserva a próxima subtarefa e grava o comando seguinte no outbox na mesma
 * transação. Assim, não existe o estado "subtarefa running sem mensagem".
 */
export class MySqlDevelopmentExecutionRepository {
  constructor(private readonly pool: Pool) {}

  /** Cadeia de modelos do programador, administrada pela Biblioteca. */
  async getDevelopmentModelChain(projectSlug: string): Promise<string[]> {
    if (!projectSlug) return []
    const [rows] = await this.pool.query<Array<RowDataPacket & { model: string }>>(
      `SELECT selection.model
         FROM project_model_selection selection
        WHERE selection.project_slug = ? AND selection.tipo = 'DEV' AND selection.enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM motor_model_cooldown cooldown
             WHERE cooldown.model COLLATE utf8mb4_unicode_ci = selection.model COLLATE utf8mb4_unicode_ci
               AND cooldown.until > NOW()
          )
        ORDER BY selection.ordem ASC`,
      [projectSlug],
    )
    return rows.map(row => String(row.model)).filter(Boolean)
  }

  /** Evita desperdiçar entregas com um modelo cuja cota/serviço acabou de falhar. */
  async recordModelFailure(model: string, error: string): Promise<void> {
    if (!model) return
    // A coluna histórica possui varchar(100); truncar aqui evita falha do
    // próprio mecanismo de recuperação em MySQL strict mode.
    const reason = error.slice(0, 100)
    const [updated] = await this.pool.query<ResultSetHeader>(
      `UPDATE motor_model_cooldown
          SET until = DATE_ADD(NOW(), INTERVAL 10 MINUTE), reason = ?,
              occurrences = occurrences + 1, updated_at = NOW()
        WHERE model COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
          AND until > NOW()`,
      [reason, model],
    )
    if (updated.affectedRows === 0) {
      await this.pool.query(
        `INSERT INTO motor_model_cooldown (model, reason, until, occurrences, created_at, updated_at)
         VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 1, NOW(), NOW())`,
        [model, reason],
      )
    }
  }

  async reserveNextSubtask(taskId: string, source: QueueMessage): Promise<ReserveNextSubtaskResult> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      const [taskRows] = await connection.query<TaskRow[]>(
        `SELECT t.id, t.external_id, t.projeto_id
           FROM tarefas t
          WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
            AND t.paused_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM bloqueios b
               WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL
            )
          LIMIT 1 FOR UPDATE`,
        [taskId, taskId],
      )
      const task = taskRows[0]
      if (!task) {
        await connection.rollback()
        return null
      }

      // Serialize reservas concorrentes nos próprios registros de configuração.
      // Sem este lock, duas mensagens podem contar o mesmo número de workers e
      // ultrapassar o limite antes de ambas alterarem pending -> running.
      const [limitRows] = await connection.query<MotorLimitRow[]>(
        `SELECT chave, CAST(JSON_UNQUOTE(valor) AS UNSIGNED) AS limite
           FROM motor_configuracoes
          WHERE chave IN ('motor.max_workers', 'motor.max_workers_per_project')
          ORDER BY chave
          FOR UPDATE`,
      )
      const limits = new Map(limitRows.map(row => [row.chave, Math.max(1, Number(row.limite ?? 1))]))
      const maxWorkers = limits.get('motor.max_workers') ?? 1
      const maxWorkersPerProject = limits.get('motor.max_workers_per_project') ?? 1

      const [globalRows] = await connection.query<ActiveDevelopmentCountRow[]>(
        `SELECT COUNT(*) AS total
           FROM subtarefas s
           INNER JOIN tarefas active_task ON active_task.id = s.tarefa_id
          WHERE active_task.tipo = 'desenvolvimento'
            AND s.status IN ('running', 'delivered', 'verifying')`,
      )
      if (Number(globalRows[0]?.total ?? 0) >= maxWorkers) {
        await this.enqueueCapacityWait(connection, task, source)
        await connection.commit()
        return { kind: 'capacity_waiting', reason: 'global_limit' }
      }

      const [projectRows] = await connection.query<ActiveDevelopmentCountRow[]>(
        `SELECT COUNT(*) AS total
           FROM subtarefas s
           INNER JOIN tarefas active_task ON active_task.id = s.tarefa_id
          WHERE active_task.tipo = 'desenvolvimento'
            AND active_task.projeto_id = ?
            AND s.status IN ('running', 'delivered', 'verifying')`,
        [task.projeto_id],
      )
      if (Number(projectRows[0]?.total ?? 0) >= maxWorkersPerProject) {
        await this.enqueueCapacityWait(connection, task, source)
        await connection.commit()
        return { kind: 'capacity_waiting', reason: 'project_limit' }
      }

      const [subtaskRows] = await connection.query<SubtaskRow[]>(
        `SELECT s.id, s.seq, s.titulo, s.scope
           FROM subtarefas s
          WHERE s.tarefa_id = ?
            AND s.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM subtarefas active
               WHERE active.tarefa_id = s.tarefa_id
                 AND active.status IN ('running', 'delivered', 'verifying')
            )
            AND NOT EXISTS (
              SELECT 1 FROM subtarefas previous
               WHERE previous.tarefa_id = s.tarefa_id
                 AND previous.seq < s.seq
                 AND previous.status NOT IN ('verified', 'superseded')
                 AND previous.id != COALESCE(s.correction_for_subtask_id, -1)
            )
            AND NOT EXISTS (
              SELECT 1
                FROM subtarefas dependency
               WHERE JSON_CONTAINS(COALESCE(s.depends_on_subtask_ids, JSON_ARRAY()), CAST(dependency.id AS JSON))
                 AND dependency.status NOT IN ('verified', 'superseded')
            )
          ORDER BY s.seq ASC
          LIMIT 1 FOR UPDATE`,
        [task.id],
      )
      const subtask = subtaskRows[0]
      if (!subtask) {
        await connection.rollback()
        return null
      }

      const executionId = `exec-subtask-${task.external_id ?? task.id}-${subtask.id}-${Date.now()}`
      const executionPayload = {
        subtaskId: Number(subtask.id),
        seq: Number(subtask.seq),
        title: String(subtask.titulo ?? ''),
        scope: String(subtask.scope ?? ''),
      }
      const message = createQueueMessage({
        type: 'SUBTASK_EXECUTION_REQUESTED',
        taskId: String(task.external_id ?? task.id),
        executionId,
        correlationId: source.correlationId ?? source.messageId,
        causationId: source.messageId,
        payload: executionPayload,
      }) as QueueMessage<typeof executionPayload>

      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE subtarefas
            SET status = 'running', updated_at = NOW()
          WHERE id = ? AND status = 'pending'`,
        [subtask.id],
      )
      if (updated.affectedRows !== 1) {
        await connection.rollback()
        return null
      }

      await connection.query(
        'DELETE FROM motor_execution_wait_queue WHERE tarefa_id = ?',
        [task.id],
      )

      await connection.query(
        `INSERT INTO motor_outbox
          (message_id, type, task_id, execution_id, payload_json, timestamp,
           correlation_id, causation_id, status, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
        [
          message.messageId,
          message.type,
          message.taskId,
          message.executionId,
          JSON.stringify(message.payload),
          new Date(message.timestamp).toISOString().slice(0, 19).replace('T', ' '),
          message.correlationId ?? null,
          message.causationId ?? null,
        ],
      )

      await connection.commit()
      return { message, subtaskId: Number(subtask.id), seq: Number(subtask.seq) }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async getExecutionContext(taskId: string, subtaskId: number, expectedStatus = 'running'): Promise<SubtaskExecutionContext | null> {
    const [rows] = await this.pool.query<ExecutionRow[]>(
      `SELECT t.id AS database_task_id, t.projeto_id AS project_id, t.external_id, t.titulo AS task_title,
              t.descricao AS task_description, s.id AS subtask_id, s.seq,
              s.titulo AS subtask_title, s.scope, s.acceptance_criteria, s.deliverables, s.completion_kind,
              pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho,
              pmc.build_command, pmc.unit_test_command,
              COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug, '') AS agent_id,
              s.workspace_path, s.workspace_branch, s.workspace_base_commit
         FROM tarefas t
         INNER JOIN subtarefas s ON s.tarefa_id = t.id
         LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
         LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
         LEFT JOIN agentes a ON a.id = pc.agente_id
        WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
          AND s.id = ? AND s.status = ?
        LIMIT 1`,
      [taskId, taskId, subtaskId, expectedStatus],
    )
    const row = rows[0]
    if (!row) return null
    return {
      taskId: String(row.external_id ?? row.database_task_id),
      databaseTaskId: Number(row.database_task_id),
      projectId: Number(row.project_id),
      subtaskId: Number(row.subtask_id),
      seq: Number(row.seq),
      taskTitle: String(row.task_title ?? ''),
      taskDescription: String(row.task_description ?? ''),
      title: String(row.subtask_title ?? ''),
      scope: String(row.scope ?? ''),
      acceptanceCriteria: this.parseStringArray(row.acceptance_criteria),
      deliverables: this.parseStringArray(row.deliverables),
      projectSlug: String(row.project_slug ?? ''),
      repoPath: String(row.repo_path ?? ''),
      baseBranch: String(row.branch_trabalho ?? ''),
      buildCommand: String(row.build_command ?? ''),
      testCommand: String(row.unit_test_command ?? ''),
      agentId: String(row.agent_id ?? ''),
      workspacePath: row.workspace_path ? String(row.workspace_path) : null,
      workspaceBranch: row.workspace_branch ? String(row.workspace_branch) : null,
      workspaceBaseCommit: row.workspace_base_commit ? String(row.workspace_base_commit) : null,
      completionKind: row.completion_kind ? String(row.completion_kind) : null,
    }
  }

  async requestVerification(context: SubtaskExecutionContext, source: QueueMessage): Promise<QueueMessage> {
    return this.transitionWithMessage(context, source, 'delivered', 'verifying', 'SUBTASK_VERIFICATION_REQUESTED', {
      subtaskId: context.subtaskId, seq: context.seq,
    })
  }

  async assertDifferentialGate(context: SubtaskExecutionContext): Promise<void> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { comparison_status: string }>>(
      `SELECT comparison_status FROM test_runs
        WHERE tarefa_id = ? AND subtarefa_id = ? AND phase IN ('post_dev', 'rework')
        ORDER BY finished_at DESC, id DESC LIMIT 1`,
      [context.databaseTaskId, context.subtaskId],
    )
    if (rows[0]?.comparison_status !== 'no_regression') {
      throw new Error('Subtarefa sem gate diferencial aprovado; integração bloqueada')
    }
  }

  async completeVerification(
    context: SubtaskExecutionContext,
    source: QueueMessage,
    evidence: { commitSha: string; integrationCommitSha: string },
  ): Promise<{ verified: QueueMessage; next: QueueMessage }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE subtarefas
            SET status = 'verified', workspace_commit_sha = ?, workspace_status = 'integrated',
                finalizada_em = NOW(), updated_at = NOW()
          WHERE id = ? AND status = 'verifying'`,
        [evidence.commitSha, context.subtaskId],
      )
      if (updated.affectedRows !== 1) throw new Error(`Subtarefa ${context.subtaskId} não está em verificação`)

      const verified = createQueueMessage({
        type: 'SUBTASK_VERIFIED', taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { subtaskId: context.subtaskId, seq: context.seq, ...evidence },
      })
      await this.insertOutbox(connection, verified)

      const reserved = await this.reserveNextSubtaskInTransaction(connection, context.databaseTaskId, context.taskId, verified)
      let next: QueueMessage
      if (reserved) {
        next = reserved.message
      } else {
        const [pending] = await connection.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS total FROM subtarefas
            WHERE tarefa_id = ? AND status NOT IN ('verified', 'superseded')`, [context.databaseTaskId],
        )
        if (Number(pending[0]?.total ?? 0) > 0) throw new Error('Existem subtarefas não concluídas, mas nenhuma está elegível')
        await connection.query(
          `INSERT INTO task_runtime_facts (tarefa_id, terminal_status, terminal_at, integration_confirmed_at, created_at, updated_at)
           VALUES (?, 'completed', NOW(), NOW(), NOW(), NOW())
           ON DUPLICATE KEY UPDATE terminal_status = 'completed', terminal_at = NOW(), integration_confirmed_at = NOW(), updated_at = NOW()`,
          [context.databaseTaskId],
        )
        next = createQueueMessage({
          type: 'TASK_EXECUTION_COMPLETED', taskId: context.taskId, executionId: source.executionId,
          correlationId: source.correlationId ?? source.messageId, causationId: verified.messageId,
          payload: { integrationCommitSha: evidence.integrationCommitSha },
        })
        await this.insertOutbox(connection, next)
        // A conclusão da integração é o fato que libera o deploy. A intenção
        // entra no mesmo outbox/transação, sem depender de varredura temporal.
        const deployRequest = createQueueMessage({
          type: 'DEPLOY_REQUESTED', taskId: context.taskId, executionId: source.executionId,
          correlationId: source.correlationId ?? source.messageId, causationId: next.messageId,
          payload: { integrationCommitSha: evidence.integrationCommitSha },
        })
        await this.insertOutbox(connection, deployRequest)
        const [testRuns] = await connection.query<Array<RowDataPacket & { id: number; pre_existing: number | string }>>(
          `SELECT tr.id,
                  SUM(tf.classification = 'pre_existing') AS pre_existing
             FROM test_runs tr
             LEFT JOIN test_failures tf ON tf.test_run_id = tr.id
            WHERE tr.tarefa_id = ? AND tr.phase IN ('post_dev', 'rework')
            GROUP BY tr.id
            ORDER BY tr.finished_at DESC, tr.id DESC LIMIT 1`,
          [context.databaseTaskId],
        )
        const sourceRun = testRuns[0]
        if (sourceRun && Number(sourceRun.pre_existing) > 0) {
          const [recovery] = await connection.query<ResultSetHeader>(
            `INSERT INTO test_recovery_attempts
              (projeto_id, source_tarefa_id, source_test_run_id, status, attempt_count, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', 0, NOW(3), NOW(3))`,
            [context.projectId, context.databaseTaskId, sourceRun.id],
          )
          const recoveryMessage = createQueueMessage({
            type: 'TEST_BASELINE_RECOVERY_REQUESTED', taskId: context.taskId, executionId: source.executionId,
            correlationId: source.correlationId ?? source.messageId, causationId: next.messageId,
            payload: { recoveryId: recovery.insertId, sourceTestRunId: sourceRun.id },
          })
          await this.insertOutbox(connection, recoveryMessage)
        }
        await this.wakeCapacityWaiters(connection, next)
      }
      await connection.commit()
      return { verified, next }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async recordWorkspace(subtaskId: number, workspacePath: string, branchName: string, baseCommit: string): Promise<void> {
    await this.pool.query(
      `UPDATE subtarefas
          SET workspace_path = ?, workspace_branch = ?, workspace_base_commit = ?,
              workspace_status = 'active', workspace_created_at = COALESCE(workspace_created_at, NOW()), updated_at = NOW()
        WHERE id = ? AND status = 'running'`,
      [workspacePath, branchName, baseCommit, subtaskId],
    )
  }

  async finishExecution(
    context: SubtaskExecutionContext,
    source: QueueMessage,
    result: { success: boolean; response?: string; error?: string; attempts: number },
  ): Promise<QueueMessage> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const nextType = result.success ? 'SUBTASK_EXECUTION_COMPLETED' : 'SUBTASK_EXECUTION_FAILED'
      const nextStatus = result.success ? 'delivered' : 'failed'
      const payload = {
        subtaskId: context.subtaskId,
        seq: context.seq,
        success: result.success,
        attempts: result.attempts,
        response: result.response ?? '',
        error: result.error ?? '',
      }
      const message = createQueueMessage({
        type: nextType,
        taskId: context.taskId,
        executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId,
        causationId: source.messageId,
        payload,
      })
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE subtarefas SET status = ?, resultado = ?, updated_at = NOW()
          WHERE id = ? AND status = 'running'`,
        [nextStatus, result.response ?? result.error ?? null, context.subtaskId],
      )
      if (updated.affectedRows !== 1) throw new Error(`Subtarefa ${context.subtaskId} não está em execução`)
      await connection.query(
        `INSERT INTO motor_outbox
          (message_id, type, task_id, execution_id, payload_json, timestamp,
           correlation_id, causation_id, status, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
        [message.messageId, message.type, message.taskId, message.executionId,
          JSON.stringify(message.payload), new Date(message.timestamp).toISOString().slice(0, 19).replace('T', ' '),
          message.correlationId ?? null, message.causationId ?? null],
      )
      if (!result.success) await this.wakeCapacityWaiters(connection, message)
      await connection.commit()
      return message
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async blockExecution(
    context: SubtaskExecutionContext,
    source: QueueMessage,
    reason: string,
  ): Promise<QueueMessage> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const message = createQueueMessage({
        type: 'SUBTASK_EXECUTION_BLOCKED',
        taskId: context.taskId,
        executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId,
        causationId: source.messageId,
        payload: { subtaskId: context.subtaskId, seq: context.seq, reason, phase: 'baseline_preflight' },
      })
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE subtarefas SET status='blocked', resultado=?, updated_at=NOW()
          WHERE id=? AND status='running'`,
        [reason.slice(0, 60_000), context.subtaskId],
      )
      if (updated.affectedRows !== 1) throw new Error(`Subtarefa ${context.subtaskId} não está em execução`)
      await this.insertOutbox(connection, message)
      await this.wakeCapacityWaiters(connection, message)
      await connection.commit()
      return message
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async completeNoCodeExecution(context: SubtaskExecutionContext, source: QueueMessage, result: string): Promise<QueueMessage> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE subtarefas SET status='verified',resultado=?,workspace_status='approved',finalizada_em=NOW(),updated_at=NOW()
         WHERE id=? AND status='running' AND completion_kind IN ('analysis','no_code_change','external_operation')`,
        [result, context.subtaskId],
      )
      if (updated.affectedRows !== 1) throw new Error(`Subtarefa analítica ${context.subtaskId} não está em execução`)
      const completed = createQueueMessage({
        type: 'SUBTASK_NO_CODE_COMPLETED', taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { subtaskId: context.subtaskId, seq: context.seq, completionKind: context.completionKind ?? 'analysis' },
      })
      await this.insertOutbox(connection, completed)
      const reserved = await this.reserveNextSubtaskInTransaction(connection, context.databaseTaskId, context.taskId, completed)
      if (reserved) {
        await connection.commit()
        return reserved.message
      }
      const [pending] = await connection.query<RowDataPacket[]>(
        `SELECT COUNT(*) total FROM subtarefas WHERE tarefa_id=? AND status NOT IN ('verified','superseded')`, [context.databaseTaskId],
      )
      if (Number(pending[0]?.total ?? 0) > 0) throw new Error('Existem subtarefas analíticas não concluídas sem dependência elegível')
      await connection.query(
        `INSERT INTO task_runtime_facts (tarefa_id,terminal_status,terminal_at,integration_confirmed_at,created_at,updated_at)
         VALUES (?,'completed',NOW(),NOW(),NOW(),NOW())
         ON DUPLICATE KEY UPDATE terminal_status='completed',terminal_at=NOW(),integration_confirmed_at=NOW(),updated_at=NOW()`,
        [context.databaseTaskId],
      )
      const taskCompleted = createQueueMessage({
        type: 'TASK_EXECUTION_COMPLETED', taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: completed.messageId,
        payload: { completionKind: context.completionKind ?? 'analysis', noCodeChange: true },
      })
      await this.insertOutbox(connection, taskCompleted)
      await this.wakeCapacityWaiters(connection, taskCompleted)
      await connection.commit()
      return taskCompleted
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  }

  private parseStringArray(value: string | null): string[] {
    if (!value) return []
    try {
      const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
      return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
    } catch {
      return []
    }
  }

  private async transitionWithMessage(
    context: SubtaskExecutionContext, source: QueueMessage, from: string, to: string,
    type: string, payload: Record<string, unknown>,
  ): Promise<QueueMessage> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [updated] = await connection.query<ResultSetHeader>(
        'UPDATE subtarefas SET status = ?, updated_at = NOW() WHERE id = ? AND status = ?',
        [to, context.subtaskId, from],
      )
      if (updated.affectedRows !== 1) throw new Error(`Subtarefa ${context.subtaskId} não está em ${from}`)
      const message = createQueueMessage({
        type, taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId, payload,
      })
      await this.insertOutbox(connection, message)
      await connection.commit()
      return message
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
  }

  private async reserveNextSubtaskInTransaction(
    connection: PoolConnection, databaseTaskId: number, taskId: string, source: QueueMessage,
  ): Promise<ReservedSubtask | null> {
    const [rows] = await connection.query<SubtaskRow[]>(
      `SELECT s.id, s.seq, s.titulo, s.scope FROM subtarefas s
        WHERE s.tarefa_id = ? AND s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM subtarefas previous
            WHERE previous.tarefa_id = s.tarefa_id AND previous.seq < s.seq
              AND previous.status NOT IN ('verified', 'superseded'))
          AND NOT EXISTS (SELECT 1 FROM subtarefas dependency
            WHERE JSON_CONTAINS(COALESCE(s.depends_on_subtask_ids, JSON_ARRAY()), CAST(dependency.id AS JSON))
              AND dependency.status NOT IN ('verified', 'superseded'))
        ORDER BY s.seq ASC LIMIT 1 FOR UPDATE`, [databaseTaskId],
    )
    const subtask = rows[0]
    if (!subtask) return null
    const payload = { subtaskId: Number(subtask.id), seq: Number(subtask.seq), title: String(subtask.titulo), scope: String(subtask.scope ?? '') }
    const message = createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED', taskId,
      executionId: `exec-subtask-${taskId}-${subtask.id}-${Date.now()}`,
      correlationId: source.correlationId ?? source.messageId, causationId: source.messageId, payload,
    }) as QueueMessage<typeof payload>
    const [updated] = await connection.query<ResultSetHeader>(
      `UPDATE subtarefas SET status = 'running', updated_at = NOW() WHERE id = ? AND status = 'pending'`, [subtask.id],
    )
    if (updated.affectedRows !== 1) return null
    await this.insertOutbox(connection, message)
    return { message, subtaskId: Number(subtask.id), seq: Number(subtask.seq) }
  }

  private async enqueueCapacityWait(
    connection: PoolConnection,
    task: TaskRow,
    source: QueueMessage,
  ): Promise<void> {
    await connection.query(
      `INSERT INTO motor_execution_wait_queue
        (tarefa_id, projeto_id, source_message_id, requested_at, status)
       VALUES (?, ?, ?, NOW(), 'waiting')
       ON DUPLICATE KEY UPDATE
         projeto_id = VALUES(projeto_id),
         source_message_id = VALUES(source_message_id),
         status = 'waiting'`,
      [task.id, task.projeto_id, source.messageId],
    )
  }

  /**
   * Publica sinais após uma vaga ser liberada. Cada consumidor ainda disputa
   * o claim atômico, por isso acordar mais de uma tarefa não ultrapassa limites.
   */
  private async wakeCapacityWaiters(connection: PoolConnection, source: QueueMessage): Promise<void> {
    const [rows] = await connection.query<Array<RowDataPacket & { tarefa_id: number; task_id: string }>>(
      `SELECT q.tarefa_id, COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id
         FROM motor_execution_wait_queue q
         INNER JOIN tarefas t ON t.id = q.tarefa_id
        WHERE q.status = 'waiting'
          AND t.paused_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status = 'pending'
          )
        ORDER BY q.requested_at ASC, q.id ASC
        LIMIT 25 FOR UPDATE`,
    )
    for (const row of rows) {
      const message = createQueueMessage({
        type: 'TASK_READY_FOR_PROGRAMMING',
        taskId: String(row.task_id),
        executionId: `exec-capacity-${row.task_id}-${Date.now()}`,
        correlationId: source.correlationId ?? source.messageId,
        causationId: source.messageId,
        payload: { reason: 'development_capacity_released' },
      })
      await this.insertOutbox(connection, message)
      await connection.query(
        `UPDATE motor_execution_wait_queue
            SET wake_count = wake_count + 1, last_woken_at = NOW()
          WHERE tarefa_id = ?`,
        [row.tarefa_id],
      )
    }
  }

  private async insertOutbox(connection: PoolConnection, message: QueueMessage): Promise<void> {
    await connection.query(
      `INSERT INTO motor_outbox
        (message_id, type, task_id, execution_id, payload_json, timestamp,
         correlation_id, causation_id, status, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      [message.messageId, message.type, message.taskId, message.executionId, JSON.stringify(message.payload),
        new Date(message.timestamp).toISOString().slice(0, 19).replace('T', ' '),
        message.correlationId ?? null, message.causationId ?? null],
    )
  }
}
