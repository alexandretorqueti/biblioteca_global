import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/index.js'

export interface DeployTaskContext {
  taskId: string
  databaseTaskId: number
  projectId: number
  repoPath: string
  baseBranch: string
  buildCommand: string
  testCommand: string
  integrationPath: string
  integrationBranch: string
  integrationCommit: string
}

export interface DeployBatch {
  batchId: string
  repoPath: string
  baseBranch: string
  expectedCommit: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  remotePid: string | null
  remoteStatusPath: string | null
  startedAt: Date | string | null
}

interface ContextRow extends RowDataPacket {
  id: number; external_id: string | null; projeto_id: number; tipo: string | null
  repo_path: string | null; branch_trabalho: string | null
  build_command: string | null; unit_test_command: string | null
  integration_confirmed_at: Date | string | null; terminal_status: string | null
  blocked: number | string
}

interface BatchRow extends RowDataPacket {
  batch_id: string; repo_path: string; base_branch: string; expected_commit: string; status: DeployBatch['status']
  remote_pid: string | null; remote_status_path: string | null; started_at: Date | string | null
}

/**
 * Persistência transacional do deploy. Este repositório é a fronteira que
 * protege claim, criação de lote e outbox contra reentrega do RabbitMQ.
 */
export class DeployRepository {
  constructor(private readonly pool: Pool, private readonly worktreeRoot: string) {}

  async getEligibleTask(taskId: string): Promise<Omit<DeployTaskContext, 'integrationPath' | 'integrationBranch' | 'integrationCommit'> | null> {
    const [rows] = await this.pool.query<ContextRow[]>(`
      SELECT t.id, t.external_id, t.projeto_id, t.tipo, pmc.repo_path, pmc.branch_trabalho,
             pmc.build_command, pmc.unit_test_command, f.integration_confirmed_at, f.terminal_status,
             EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id=t.id AND b.resolved_at IS NULL) AS blocked
        FROM tarefas t
        LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
        LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id
       WHERE t.external_id=? OR CAST(t.id AS CHAR)=?
       LIMIT 1`, [taskId, taskId])
    const row = rows[0]
    if (!row) return null
    if (String(row.tipo) !== 'desenvolvimento') throw new Error('Deploy permitido apenas para tarefa de desenvolvimento')
    if (row.integration_confirmed_at == null || String(row.terminal_status) !== 'completed') throw new Error('Deploy exige tarefa integrada e concluída')
    if (Number(row.blocked) !== 0) throw new Error('Deploy bloqueado: tarefa possui bloqueio ativo')
    if (!row.repo_path || !row.branch_trabalho || !row.build_command || !row.unit_test_command) throw new Error('Deploy bloqueado: configuração de repositório, branch ou gate ausente')
    return {
      taskId: String(row.external_id ?? row.id), databaseTaskId: Number(row.id), projectId: Number(row.projeto_id),
      repoPath: String(row.repo_path), baseBranch: String(row.branch_trabalho),
      buildCommand: String(row.build_command), testCommand: String(row.unit_test_command),
    }
  }

  withIntegration(context: Omit<DeployTaskContext, 'integrationPath' | 'integrationBranch' | 'integrationCommit'>, integrationCommit: string): DeployTaskContext {
    const safeTask = context.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    return {
      ...context, integrationCommit,
      integrationPath: `${this.worktreeRoot}/${safeTask}/integration`,
      integrationBranch: `motor-v3-work/integration-${safeTask}`,
    }
  }

  /** Gate verde é uma invariant do deploy, inclusive em retry/restart. */
  async assertPreDeployGate(context: DeployTaskContext): Promise<void> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number; status: string; failures: number | string }>>(
      `SELECT tr.id,tr.status,(SELECT COUNT(*) FROM test_failures tf WHERE tf.test_run_id=tr.id) AS failures
         FROM test_runs tr WHERE tr.tarefa_id=? AND tr.phase='pre_deploy' AND tr.commit_sha=?
         ORDER BY tr.finished_at DESC,tr.id DESC LIMIT 1`, [context.databaseTaskId, context.integrationCommit],
    )
    const gate = rows[0]
    if (!gate || gate.status !== 'passed' || Number(gate.failures) > 0) throw new Error('Deploy bloqueado: gate pre_deploy ausente ou vermelho para o commit de integração')
  }

  /** Persiste pedido e comando de lote na mesma transação. */
  async acceptRequest(context: DeployTaskContext, source: QueueMessage): Promise<{ requestId: number; dispatch: QueueMessage }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await this.assertStillEligible(connection, context)
      const [insert] = await connection.query<ResultSetHeader>(
        `INSERT INTO deploy_requests (tarefa_id,repo_path,status,requested_commit,base_branch,requested_at,updated_at)
         VALUES (?,?,'pending',?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE repo_path=VALUES(repo_path),requested_commit=VALUES(requested_commit),base_branch=VALUES(base_branch),
           status=IF(status IN ('succeeded','running'),status,'pending'),last_error=NULL,updated_at=NOW()`,
        [context.databaseTaskId, context.repoPath, context.integrationCommit, context.baseBranch],
      )
      const dispatch = createQueueMessage({
        type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: context.taskId,
        executionId: `deploy-dispatch-${context.taskId}-${source.messageId}`,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { repository: context.repoPath, baseBranch: context.baseBranch, expectedCommit: context.integrationCommit },
      })
      await this.insertOutbox(connection, dispatch)
      const accepted = createQueueMessage({ type: 'DEPLOY_REQUEST_ACCEPTED', taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { requestId: Number(insert.insertId), expectedCommit: context.integrationCommit } })
      await this.insertOutbox(connection, accepted)
      await connection.commit()
      return { requestId: Number(insert.insertId), dispatch }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /** Claim de um lote compatível; nunca agrupa commits diferentes. */
  async claimBatch(source: QueueMessage): Promise<{ batch: DeployBatch; taskIds: string[] } | null> {
    const repoPath = String(source.payload.repository ?? '')
    const baseBranch = String(source.payload.baseBranch ?? '')
    const expectedCommit = String(source.payload.expectedCommit ?? '')
    if (!repoPath || !baseBranch || !expectedCommit) throw new Error('Comando de lote de deploy incompleto')
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [busy] = await connection.query<Array<RowDataPacket & { total: number | string }>>(
        `SELECT COUNT(*) AS total FROM deploy_batches WHERE repo_path=? AND status IN ('pending','running') FOR UPDATE`, [repoPath])
      if (Number(busy[0]?.total ?? 0) > 0) { await connection.rollback(); return null }
      const [requests] = await connection.query<Array<RowDataPacket & { id: number; task_id: number; external_id: string | null }>>(
        `SELECT dr.id,dr.tarefa_id,t.external_id FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
          WHERE dr.repo_path=? AND dr.base_branch=? AND dr.requested_commit=? AND dr.status='pending'
          ORDER BY dr.id FOR UPDATE`, [repoPath, baseBranch, expectedCommit])
      if (requests.length === 0) { await connection.rollback(); return null }
      const batchId = `deploy-${randomUUID()}`
      await connection.query(
        `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,created_at,updated_at)
         VALUES (?,?,?,?, 'pending',NOW(),NOW())`, [batchId, repoPath, baseBranch, expectedCommit])
      const ids = requests.map(row => row.id)
      await connection.query(`UPDATE deploy_requests SET status='running',batch_id=?,started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id IN (${ids.map(() => '?').join(',')}) AND status='pending'`, [batchId, ...ids])
      await connection.commit()
      return { batch: { batchId, repoPath, baseBranch, expectedCommit, status: 'pending', remotePid: null, remoteStatusPath: null, startedAt: null }, taskIds: requests.map(row => String(row.external_id ?? row.task_id)) }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  async markRemoteStarted(batchId: string, remotePid: string, statusPath: string, source: QueueMessage): Promise<QueueMessage> {
    const reconcile = createQueueMessage({ type: 'DEPLOY_RECONCILIATION_REQUESTED', taskId: source.taskId,
      executionId: `deploy-reconcile-${batchId}`, correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
      payload: { batchId } })
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [updated] = await connection.query<ResultSetHeader>(`UPDATE deploy_batches SET status='running',remote_pid=?,remote_status_path=?,started_at=NOW(),updated_at=NOW() WHERE batch_id=? AND status='pending'`, [remotePid, statusPath, batchId])
      if (updated.affectedRows !== 1) throw new Error(`Lote ${batchId} não está pendente para iniciar`)
      const started = createQueueMessage({ type: 'DEPLOY_BATCH_STARTED', taskId: source.taskId,
        executionId: source.executionId, correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { batchId, remotePid, statusPath } })
      await this.insertOutbox(connection, started)
      await this.insertOutbox(connection, reconcile)
      await connection.commit()
      return reconcile
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  async runningBatches(): Promise<DeployBatch[]> {
    const [rows] = await this.pool.query<BatchRow[]>(`SELECT batch_id,repo_path,base_branch,expected_commit,status,remote_pid,remote_status_path,started_at FROM deploy_batches WHERE status='running' ORDER BY started_at`)
    return rows.map(row => ({ batchId: row.batch_id, repoPath: row.repo_path, baseBranch: row.base_branch, expectedCommit: row.expected_commit, status: row.status, remotePid: row.remote_pid, remoteStatusPath: row.remote_status_path, startedAt: row.started_at }))
  }

  /** O scheduler só persiste comandos; o consumidor continua sendo o executor. */
  async enqueueReconciliationForRunning(): Promise<number> {
    const batches = await this.runningBatches()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      for (const batch of batches) {
        const message = createQueueMessage({ type: 'DEPLOY_RECONCILIATION_REQUESTED', taskId: 'system', executionId: `deploy-reconcile-${batch.batchId}`,
          payload: { batchId: batch.batchId } })
        await this.insertOutbox(connection, message)
      }
      await connection.commit()
      return batches.length
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  async completeBatch(batchId: string, success: boolean, reason: string | null, source: QueueMessage): Promise<string[]> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const finalStatus = success ? 'succeeded' : 'failed'
      const [batch] = await connection.query<ResultSetHeader>(`UPDATE deploy_batches SET status=?,last_error=?,finished_at=NOW(),updated_at=NOW() WHERE batch_id=? AND status='running'`, [finalStatus, reason, batchId])
      if (batch.affectedRows === 0) { await connection.rollback(); return [] }
      const [requests] = await connection.query<Array<RowDataPacket & { external_id: string | null; task_id: number }>>(`SELECT t.external_id,dr.tarefa_id FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id WHERE dr.batch_id=? FOR UPDATE`, [batchId])
      await connection.query(`UPDATE deploy_requests SET status=?,last_error=?,finished_at=NOW(),updated_at=NOW() WHERE batch_id=? AND status='running'`, [finalStatus, reason, batchId])
      if (!success) await connection.query(`INSERT INTO bloqueios (tarefa_id,subtarefa_id,block_reason,block_command,block_excerpt,blocked_at)
        SELECT tarefa_id,NULL,'deploy_failed',?, ?,NOW() FROM deploy_requests WHERE batch_id=?`, [`motor-v3:deploy:${batchId}`, String(reason ?? 'Falha no deploy').slice(0, 500), batchId])
      const batchEvent = createQueueMessage({ type: success ? 'DEPLOY_BATCH_SUCCEEDED' : 'DEPLOY_BATCH_FAILED', taskId: source.taskId,
        executionId: source.executionId, correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { batchId, reason } })
      await this.insertOutbox(connection, batchEvent)
      for (const request of requests) {
        const taskId = String(request.external_id ?? request.task_id)
        const event = createQueueMessage({ type: success ? 'TASK_DEPLOYED' : 'TASK_DEPLOY_BLOCKED', taskId,
          executionId: source.executionId, correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
          payload: { batchId, reason } })
        await this.insertOutbox(connection, event)
      }
      await connection.commit()
      return requests.map(row => String(row.external_id ?? row.task_id))
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  private async assertStillEligible(connection: PoolConnection, context: DeployTaskContext): Promise<void> {
    const [rows] = await connection.query<ContextRow[]>(`SELECT t.id,t.tipo,f.integration_confirmed_at,f.terminal_status,
      EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id=t.id AND b.resolved_at IS NULL) AS blocked
      FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id WHERE t.id=? FOR UPDATE`, [context.databaseTaskId])
    const task = rows[0]
    if (!task || String(task.tipo) !== 'desenvolvimento' || task.integration_confirmed_at == null || task.terminal_status !== 'completed' || Number(task.blocked) !== 0) throw new Error('Tarefa deixou de ser elegível para deploy')
  }

  private async insertOutbox(connection: PoolConnection, message: QueueMessage): Promise<void> {
    await connection.query(`INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
      VALUES (?,?, 'motor.commands',?,?,?,NOW(),?,?,'pending',0)`, [message.messageId, message.type, message.taskId, message.executionId, JSON.stringify(message.payload), message.correlationId ?? null, message.causationId ?? null])
  }
}
