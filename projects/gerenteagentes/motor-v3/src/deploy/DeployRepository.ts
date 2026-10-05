import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, insertOutboxMessage, type QueueMessage } from '../queue/index.js'
import { createTaskBlockedMessage } from '../monitor/index.js'

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
  workspacePath: string | null
  gateJobId: number | null
}

export interface DeployBatchMember {
  databaseTaskId: number
  taskId: string
  requestedCommit: string
  projectId: number
  buildCommand: string
  testCommand: string
}

/** Branch de integração que deve receber a base recém implantada. */
export interface IntegrationBranchSyncTarget {
  taskId: string
  repoPath: string
  baseBranch: string
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
  remote_pid: string | null; remote_status_path: string | null; started_at: Date | string | null; workspace_path: string | null; gate_job_id: number | null
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

  /** Recupera tarefas concluídas sem deploy ativo/sucedido no mesmo banco/outbox. */
  async enqueueCompletedRecoveries(): Promise<number> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [tasks] = await connection.query<Array<RowDataPacket & { id: number; external_id: string | null }>>(`
        SELECT t.id,t.external_id FROM tarefas t
        INNER JOIN task_runtime_facts f ON f.tarefa_id=t.id AND f.terminal_status='completed' AND f.integration_confirmed_at IS NOT NULL
        WHERE t.tipo='desenvolvimento'
          AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id=t.id AND b.resolved_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id=t.id AND d.status IN ('pending','running','succeeded'))
        FOR UPDATE`)
      for (const task of tasks) {
        const taskId = String(task.external_id ?? task.id)
        const message = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId, executionId: `deploy-recovery-${taskId}-${Date.now()}`, payload: { recovered: true } })
        await this.insertOutbox(connection, message)
      }
      await connection.commit()
      return tasks.length
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /** Fecha um pedido aceito quando o gate não pôde ser enfileirado. */
  async failPendingRequest(taskId: string, reason: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
          SET dr.status='failed',dr.last_error=?,dr.finished_at=NOW(),dr.updated_at=NOW()
        WHERE (t.external_id=? OR CAST(t.id AS CHAR)=?) AND dr.status='pending'`,
      [reason, taskId, taskId],
    )
    return Number(result.affectedRows ?? 0) > 0
  }

  /** A ociosidade vem de fatos persistidos, nunca de memória do processo. */
  async isMotorIdle(): Promise<boolean> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { active: number | string }>>(`
      SELECT (
        EXISTS(SELECT 1 FROM subtarefas WHERE status IN ('running','delivered','verifying'))
        OR EXISTS(SELECT 1 FROM task_runtime_facts WHERE analysis_started_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM test_gate_jobs WHERE status IN ('pending','processing'))
      ) AS active`)
    return Number(rows[0]?.active ?? 0) === 0
  }

  /**
   * Adquire o lock de deploy. Idempotente: se já está locked pelo mesmo batchId,
   * retorna true (re-entrant). Se está locked por outro batchId, retorna false.
   * Usa INSERT ON DUPLICATE KEY UPDATE para atomicidade.
   */
  async acquireDeployLock(batchId: string, reason: string): Promise<boolean> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      // Verifica se já está locked por outro batch
      const [current] = await connection.query<Array<RowDataPacket & { locked: number | string; locked_by: string | null }>>(
        `SELECT locked, locked_by FROM motor_deploy_lock WHERE id = 1 FOR UPDATE`
      )
      const row = current[0]
      if (row && Number(row.locked) === 1 && row.locked_by && row.locked_by !== batchId) {
        // Locked por outro batch — não pode adquirir
        await connection.commit()
        return false
      }
      // Adquire ou re-adquire (mesmo batchId)
      await connection.query(
        `INSERT INTO motor_deploy_lock (id, locked, locked_at, locked_by, reason)
         VALUES (1, TRUE, NOW(), ?, ?)
         ON DUPLICATE KEY UPDATE
           locked = TRUE,
           locked_at = NOW(),
           locked_by = VALUES(locked_by),
           reason = VALUES(reason)`,
        [batchId, reason.slice(0, 500)]
      )
      await connection.commit()
      return true
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Libera o lock de deploy. Limpa metadados (locked_at, locked_by, reason).
   * Idempotente: se já está unlocked, não faz nada.
   */
  async releaseDeployLock(ownerBatchId?: string): Promise<void> {
    await this.pool.query<ResultSetHeader>(
      ownerBatchId
        ? `UPDATE motor_deploy_lock
           SET locked = FALSE, locked_at = NULL, locked_by = NULL, reason = NULL
           WHERE id = 1 AND locked_by = ?`
        : `UPDATE motor_deploy_lock
           SET locked = FALSE, locked_at = NULL, locked_by = NULL, reason = NULL
           WHERE id = 1`,
      ownerBatchId ? [ownerBatchId] : [],
    )
  }

  /**
   * Verifica se o lock de deploy está ativo. Retorna true se locked.
   */
  async isDeployLocked(): Promise<boolean> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { locked: number | string }>>(
      `SELECT locked FROM motor_deploy_lock WHERE id = 1`
    )
    const row = rows[0]
    if (!row) return false
    return Number(row.locked) === 1
  }

  /**
   * Aguarda todas as execuções ativas terminarem (análises, subtarefas, test gates).
   * Poll isMotorIdle() em intervalos de 5s até timeout.
   * Retorna {completed: boolean, forced: boolean}:
   * - completed=true: motor ficou ocioso antes do timeout
   * - completed=false, forced=true: timeout expirou, deploy deve prosseguir forçadamente
   * - completed=false, forced=false: não deveria ocorrer (timeout sem forçar)
   */
  async waitForActiveExecutionsToComplete(timeoutMs: number): Promise<{ completed: boolean; forced: boolean }> {
    const pollIntervalMs = 5000
    const startTime = Date.now()
    while (true) {
      const idle = await this.isMotorIdle()
      if (idle) {
        return { completed: true, forced: false }
      }
      const elapsed = Date.now() - startTime
      if (elapsed >= timeoutMs) {
        return { completed: false, forced: true }
      }
      // Aguarda próximo poll (ou o restante do timeout, o que for menor)
      const waitMs = Math.min(pollIntervalMs, timeoutMs - elapsed)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }

  async requeueDispatch(source: QueueMessage, reason: string): Promise<void> {
    const message = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: source.taskId,
      executionId: `${source.executionId}-retry-${Date.now()}`, correlationId: source.correlationId ?? source.messageId,
      causationId: source.messageId, payload: { ...source.payload, deferredReason: reason } })
    const connection = await this.pool.getConnection()
    try { await connection.beginTransaction(); await this.insertOutbox(connection, message); await connection.commit() }
    catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /**
   * Reenfileira mensagem rejeitada por deploy lock com delay de 30s.
   * Insere no outbox com timestamp futuro (NOW() + 30s); o OutboxPublisher
   * só publica mensagens cujo timestamp <= NOW(), garantindo o delay.
   * A mensagem original é acked pelo consumidor; esta nova mensagem será
   * publicada automaticamente após o deploy terminar (ou após 30s).
   */
  async requeueForDeployRetry(source: QueueMessage, reason: string): Promise<void> {
    const retryMessage = createQueueMessage({
      type: source.type,
      taskId: source.taskId,
      executionId: `${source.executionId}-deploy-retry-${Date.now()}`,
      correlationId: source.correlationId ?? source.messageId,
      causationId: source.messageId,
      payload: { ...source.payload, deferredReason: reason, retryAfter: '30s' },
    })
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      // Insere com timestamp futuro (NOW() + 30s) para delay no publish
      await connection.query(
        `INSERT INTO motor_outbox (message_id, type, destination_queue, task_id, execution_id, payload_json, timestamp, correlation_id, causation_id, status, attempt)
         VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 SECOND), ?, ?, 'pending', 0)`,
        [retryMessage.messageId, retryMessage.type, 'motor.commands', retryMessage.taskId, retryMessage.executionId,
          JSON.stringify(retryMessage.payload), retryMessage.correlationId ?? null, retryMessage.causationId ?? null],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async blockTask(taskId: string, reason: string, detail: string, source?: QueueMessage): Promise<void> {
    const excerpt = detail.slice(0, 500)
    const blocked = createTaskBlockedMessage({
      taskId,
      executionId: source ? `${source.executionId}-block-${Date.now()}` : `block-${taskId}-${Date.now()}`,
      correlationId: source?.correlationId ?? source?.messageId,
      causationId: source?.messageId,
      payload: { blockReason: reason, blockCommand: 'motor-v3:deploy', blockExcerpt: excerpt },
    })
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(`INSERT INTO bloqueios (tarefa_id,subtarefa_id,block_reason,block_command,block_excerpt,blocked_at)
        SELECT t.id,NULL,?,?,?,NOW() FROM tarefas t
         WHERE t.external_id=? OR CAST(t.id AS CHAR)=?`, [reason, 'motor-v3:deploy', excerpt, taskId, taskId])
      await this.insertOutbox(connection, blocked)
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /**
   * Bloqueia todas as tarefas de um lote por conflito de merge com diagnóstico estruturado.
   * Persiste em bloqueios (merge_conflict), promotion_conflict_analyses e tarefa_chats.
   */
  async blockBatchForMergeConflict(
    batchId: string,
    conflictData: {
      baseBranch: string
      taskBranch: string
      baseCommit: string
      taskCommit: string
      mergeBaseCommit: string
      conflictFiles: string[]
      command: string
    },
    source: QueueMessage,
  ): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      
      // Marcar batch como failed
      await connection.query(
        `UPDATE deploy_batches SET status='failed', last_error=?, finished_at=NOW(), updated_at=NOW() WHERE batch_id=? AND status IN ('pending','running')`,
        [`Conflito de merge: ${conflictData.conflictFiles.join(', ')}`, batchId]
      )
      
      // Atualizar deploy_requests para failed
      await connection.query(
        `UPDATE deploy_requests SET status='failed', last_error=?, finished_at=NOW(), updated_at=NOW() WHERE batch_id=? AND status='running'`,
        [`Conflito de merge: ${conflictData.conflictFiles.join(', ')}`, batchId]
      )
      
      // Buscar tarefas do lote
      const [requests] = await connection.query<Array<RowDataPacket & { external_id: string | null; task_id: number }>>(
        `SELECT t.external_id, dr.tarefa_id AS task_id FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id WHERE dr.batch_id=? FOR UPDATE`,
        [batchId]
      )
      
      // Gerar fingerprint único para o conflito
      const fingerprint = `conflict:${batchId}:${conflictData.taskCommit.slice(0, 12)}`
      
      // Preparar JSON de arquivos conflitantes
      const conflictFilesJson = JSON.stringify(conflictData.conflictFiles)
      
      // Preparar evidência estruturada
      const evidenceJson = JSON.stringify({
        type: 'merge_conflict',
        baseBranch: conflictData.baseBranch,
        taskBranch: conflictData.taskBranch,
        baseCommit: conflictData.baseCommit,
        taskCommit: conflictData.taskCommit,
        mergeBaseCommit: conflictData.mergeBaseCommit,
        conflictFiles: conflictData.conflictFiles,
        command: conflictData.command,
        batchId,
      })
      
      // Mensagem descritiva para o chat da tarefa
      const chatMessage = `⚠️ **Conflito de merge detectado no deploy**

**O que aconteceu:** O motor tentou promover seu commit para a branch ${conflictData.baseBranch}, mas encontrou conflitos reais com mudanças que ocorreram na base enquanto você desenvolvia.

**Etapa:** Promoção para branch de integração (git merge)

**Arquivos conflitantes (${conflictData.conflictFiles.length}):**
${conflictData.conflictFiles.map(f => `- \`${f}\``).join('\n')}

**Commit da tarefa:** \`${conflictData.taskCommit.slice(0, 8)}\`
**Branch de destino:** \`${conflictData.baseBranch}\`
**Comando que falhou:** \`${conflictData.command}\`

**Ação necessária:** Rebase ou merge manual da branch ${conflictData.baseBranch} na sua branch de trabalho, resolvendo os conflitos nos arquivos listados. Após resolver, o deploy será tentado novamente.`
      
      for (const request of requests) {
        const taskId = String(request.external_id ?? request.task_id)
        const databaseTaskId = Number(request.task_id)
        
        // 1. Inserir bloqueio com merge_conflict
        const [bloqueioInsert] = await connection.query<ResultSetHeader>(
          `INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at)
           VALUES (?, NULL, 'merge_conflict', ?, ?, NOW())`,
          [databaseTaskId, conflictData.command, `Conflito de merge: ${conflictData.conflictFiles.join(', ')}`.slice(0, 500)]
        )
        const bloqueioId = Number(bloqueioInsert.insertId)
        
        // 2. Inserir em promotion_conflict_analyses
        await connection.query(
          `INSERT INTO promotion_conflict_analyses (
            tarefa_id, bloqueio_id, fingerprint, base_branch, task_branch,
            base_commit, task_commit, merge_base_commit, conflict_files_json,
            evidence_json, status, confidence, recommendation, started_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'high', 'manual_rebase', NOW(), NOW())`,
          [
            databaseTaskId,
            bloqueioId,
            fingerprint,
            conflictData.baseBranch,
            conflictData.taskBranch,
            conflictData.baseCommit || 'unknown',
            conflictData.taskCommit,
            conflictData.mergeBaseCommit || 'unknown',
            conflictFilesJson,
            evidenceJson,
          ]
        )
        
        // 3. Inserir mensagem no chat da tarefa
        await connection.query(
          `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'assistant', ?, NOW())`,
          [databaseTaskId, chatMessage]
        )
        
        // 4. Publicar evento TASK_BLOCKED no outbox (feed operacional)
        const blocked = createTaskBlockedMessage({
          taskId,
          executionId: `${source.executionId}-merge-conflict-${batchId}`,
          correlationId: source.correlationId ?? source.messageId,
          causationId: source.messageId,
          payload: {
            blockReason: 'merge_conflict',
            blockCommand: conflictData.command,
            blockExcerpt: `Conflito de merge: ${conflictData.conflictFiles.join(', ')}`.slice(0, 500),
            batchId,
            databaseTaskId,
            conflictFiles: conflictData.conflictFiles,
            baseBranch: conflictData.baseBranch,
            taskBranch: conflictData.taskBranch,
            taskCommit: conflictData.taskCommit,
          },
        })
        await this.insertOutbox(connection, blocked)
      }
      
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
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
  async acceptRequest(context: DeployTaskContext, source: QueueMessage): Promise<{ requestId: number }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await this.assertStillEligible(connection, context)
      const [insert] = await connection.query<ResultSetHeader>(
        `INSERT INTO deploy_requests (tarefa_id,repo_path,status,requested_commit,base_branch,generation,parent_generation,requested_at,updated_at)
         VALUES (?,?,'pending',?,?,
           (SELECT COALESCE(MAX(s.generation), 1) FROM subtarefas s WHERE s.tarefa_id = ?),
           (SELECT CASE WHEN COALESCE(MAX(s.generation), 1) > 1 THEN MAX(s.generation) - 1 ELSE NULL END FROM subtarefas s WHERE s.tarefa_id = ?),
           NOW(),NOW())
         ON DUPLICATE KEY UPDATE repo_path=VALUES(repo_path),requested_commit=VALUES(requested_commit),base_branch=VALUES(base_branch),
           generation=VALUES(generation),parent_generation=VALUES(parent_generation),
           status=IF(status IN ('succeeded','running'),status,'pending'),batch_id=IF(status IN ('succeeded','running'),batch_id,NULL),last_error=NULL,updated_at=NOW()`,
        [context.databaseTaskId, context.repoPath, context.integrationCommit, context.baseBranch,
         context.databaseTaskId, context.databaseTaskId],
      )
      const accepted = createQueueMessage({ type: 'DEPLOY_REQUEST_ACCEPTED', taskId: context.taskId, executionId: source.executionId,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { requestId: Number(insert.insertId), expectedCommit: context.integrationCommit } })
      await this.insertOutbox(connection, accepted)
      await connection.commit()
      return { requestId: Number(insert.insertId) }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /** Converte o fato TEST_RUN_COMPLETED em próximo comando; não há espera ativa. */
  async continueAfterPreDeployGate(taskId: string, testRunId: number, source: QueueMessage): Promise<{ accepted: boolean; reason?: string }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [runs] = await connection.query<Array<RowDataPacket & { status: string; failures: number | string; commit_sha: string }>>(
        `SELECT tr.status,tr.commit_sha,(SELECT COUNT(*) FROM test_failures tf WHERE tf.test_run_id=tr.id) AS failures
           FROM test_runs tr WHERE tr.id=? AND tr.phase='pre_deploy' LIMIT 1 FOR UPDATE`, [testRunId])
      const run = runs[0]
      if (!run) {
        await connection.commit()
        await this.blockTask(taskId, 'pre_deploy_gate_failed', 'Gate pre_deploy falhou', source)
        return { accepted: false, reason: 'pre_deploy_gate_failed' }
      }
      const [requests] = await connection.query<Array<RowDataPacket & { repo_path: string; base_branch: string; requested_commit: string }>>(
        `SELECT dr.repo_path,dr.base_branch,dr.requested_commit FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
          WHERE (t.external_id=? OR CAST(t.id AS CHAR)=?) AND dr.status='pending' AND dr.requested_commit=? LIMIT 1 FOR UPDATE`, [taskId, taskId, run.commit_sha])
      const request = requests[0]
      // Pedido não pendente (deploy já concluído por outro caminho ou job obsoleto
      // reenfileirado pela recuperação de órfãos): nada a bloquear nem a despachar.
      // Bloquear aqui criaria bloqueio espúrio em tarefa já implantada.
      if (!request) { await connection.commit(); return { accepted: false, reason: 'deploy_request_not_pending' } }
      if (run.status !== 'passed' || Number(run.failures) > 0) {
        const reason = `Gate pre_deploy falhou (status=${run.status}, falhas=${Number(run.failures)})`
        await connection.query(`UPDATE deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
          SET dr.status='failed',dr.last_error=?,dr.finished_at=NOW(),dr.updated_at=NOW()
          WHERE (t.external_id=? OR CAST(t.id AS CHAR)=?) AND dr.status='pending'`, [reason, taskId, taskId])
        await connection.commit()
        await this.blockTask(taskId, 'pre_deploy_gate_failed', reason, source)
        return { accepted: false, reason: 'pre_deploy_gate_failed' }
      }
      const dispatch = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId, executionId: `deploy-dispatch-${taskId}-${source.messageId}`,
        correlationId: source.correlationId ?? source.messageId, causationId: source.messageId,
        payload: { repository: request.repo_path, baseBranch: request.base_branch, expectedCommit: request.requested_commit } })
      await this.insertOutbox(connection, dispatch)
      await connection.commit()
      return { accepted: true }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /**
   * Claim de todas as solicitações compatíveis do mesmo repositório/branch.
   *
   * O artefato implantado é a branch-base composta, não um commit de uma
   * tarefa isolada. O primeiro comando apenas desperta o lote; os commits de
   * todas as tarefas pendentes e compatíveis são compostos e validados juntos.
   */
  async claimBatch(source: QueueMessage): Promise<{ batch: DeployBatch; members: DeployBatchMember[] } | null> {
    const repoPath = String(source.payload.repository ?? '')
    const baseBranch = String(source.payload.baseBranch ?? '')
    const expectedCommit = String(source.payload.expectedCommit ?? '')
    if (!repoPath || !baseBranch || !expectedCommit) throw new Error('Comando de lote de deploy incompleto')
    if (!await this.isMotorIdle()) return null
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [busy] = await connection.query<Array<RowDataPacket & { total: number | string }>>(
        `SELECT COUNT(*) AS total FROM deploy_batches WHERE repo_path=? AND status IN ('pending','running') FOR UPDATE`, [repoPath])
      if (Number(busy[0]?.total ?? 0) > 0) { await connection.rollback(); return null }
      const [seedRows] = await connection.query<Array<RowDataPacket & { build_command: string | null; test_command: string | null }>>(
        `SELECT pmc.build_command,pmc.unit_test_command AS test_command
           FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
           LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
          WHERE dr.repo_path=? AND dr.base_branch=? AND dr.status='pending' AND dr.requested_commit=?
          LIMIT 1 FOR UPDATE`, [repoPath, baseBranch, expectedCommit])
      const seed = seedRows[0]
      if (!seed) { await connection.rollback(); return null }
      if (!seed.build_command || !seed.test_command) throw new Error('Pedido de deploy sem comandos de gate')
      const [requests] = await connection.query<Array<RowDataPacket & { id: number; task_id: number; external_id: string | null; requested_commit: string; project_id: number; build_command: string | null; test_command: string | null }>>(
        `SELECT dr.id,dr.tarefa_id AS task_id,t.external_id,dr.requested_commit,t.projeto_id AS project_id,pmc.build_command,pmc.unit_test_command AS test_command
          FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
          LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
          WHERE dr.repo_path=? AND dr.base_branch=? AND dr.status='pending'
            AND pmc.build_command=? AND pmc.unit_test_command=?
          ORDER BY dr.id FOR UPDATE`, [repoPath, baseBranch, seed.build_command, seed.test_command])
      if (requests.length === 0) { await connection.rollback(); return null }
      if (requests.some(row => !row.requested_commit || !row.build_command || !row.test_command)) throw new Error('Pedido de deploy sem commit ou comandos de gate')
      const batchId = `deploy-${randomUUID()}`
      await connection.query(
        `INSERT INTO deploy_batches (batch_id,repo_path,base_branch,expected_commit,status,created_at,updated_at)
         VALUES (?,?,?,?, 'pending',NOW(),NOW())`, [batchId, repoPath, baseBranch, expectedCommit])
      const ids = requests.map(row => row.id)
      await connection.query(`UPDATE deploy_requests SET status='running',batch_id=?,started_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id IN (${ids.map(() => '?').join(',')}) AND status='pending'`, [batchId, ...ids])
      await connection.commit()
      return {
        batch: { batchId, repoPath, baseBranch, expectedCommit, status: 'pending', remotePid: null, remoteStatusPath: null, startedAt: null, workspacePath: null, gateJobId: null },
        members: requests.map(row => ({ databaseTaskId: Number(row.task_id), taskId: String(row.external_id ?? row.task_id), requestedCommit: String(row.requested_commit), projectId: Number(row.project_id), buildCommand: String(row.build_command), testCommand: String(row.test_command) })),
      }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  async setBatchPrepared(batchId: string, expectedCommit: string, workspacePath: string, gateJobId: number): Promise<void> {
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE deploy_batches SET expected_commit=?,workspace_path=?,gate_job_id=?,updated_at=NOW() WHERE batch_id=? AND status='pending'`, [expectedCommit, workspacePath, gateJobId, batchId])
    if (result.affectedRows !== 1) throw new Error(`Lote ${batchId} não está pendente para receber commit composto`)
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
    const [rows] = await this.pool.query<BatchRow[]>(`SELECT batch_id,repo_path,base_branch,expected_commit,status,remote_pid,remote_status_path,started_at,workspace_path,gate_job_id FROM deploy_batches WHERE status='running' ORDER BY started_at`)
    return rows.map(row => this.mapBatch(row))
  }

  async findPendingBatchByGateJob(gateJobId: number): Promise<DeployBatch | null> {
    const [rows] = await this.pool.query<BatchRow[]>(`SELECT batch_id,repo_path,base_branch,expected_commit,status,remote_pid,remote_status_path,started_at,workspace_path,gate_job_id FROM deploy_batches WHERE gate_job_id=? AND status='pending' LIMIT 1`, [gateJobId])
    return rows[0] ? this.mapBatch(rows[0]) : null
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

  /** Ciclo controlado que dá nova oportunidade a pedidos adiados por ociosidade/lote ativo. */
  async enqueuePendingDispatches(): Promise<number> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const count = await this.insertPendingDispatches(connection)
      await connection.commit()
      return count
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /**
   * Libera batches que ficaram pendentes antes de receber um gate.
   * O próximo ciclo de insertPendingDispatches reenfileira os pedidos
   * devolvidos a pending.
   */
  async reconcileOrphanPendingBatches(): Promise<number> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [orphanRows] = await connection.query<Array<RowDataPacket & { batch_id: string }>>(
        `SELECT batch_id
           FROM deploy_batches
          WHERE status='pending'
            AND gate_job_id IS NULL
            AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
          FOR UPDATE`,
      )
      const batchIds = orphanRows.map(row => String(row.batch_id))
      if (batchIds.length === 0) {
        await connection.commit()
        return 0
      }

      const placeholders = batchIds.map(() => '?').join(',')
      await connection.query(
        `UPDATE deploy_batches
            SET status='failed',
                last_error='Batch órfão: pending há mais de 30 minutos sem processamento',
                finished_at=NOW(),
                updated_at=NOW()
          WHERE batch_id IN (${placeholders})
            AND status='pending'
            AND gate_job_id IS NULL`,
        batchIds,
      )
      await connection.query(
        `UPDATE deploy_requests
            SET status='pending',
                batch_id=NULL,
                started_at=NULL,
                finished_at=NULL,
                last_error=NULL,
                updated_at=NOW()
          WHERE batch_id IN (${placeholders})
            AND status='running'`,
        batchIds,
      )
      await connection.commit()
      return batchIds.length
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /** Repo associado ao último pedido de deploy da tarefa (necessário para limpar worktrees pós-deploy). */
  async repoPathForTask(taskId: string): Promise<string | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { repo_path: string | null }>>(
      `SELECT dr.repo_path FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
        WHERE t.external_id=? OR CAST(t.id AS CHAR)=? ORDER BY dr.id DESC LIMIT 1`, [taskId, taskId])
    return rows[0]?.repo_path ? String(rows[0].repo_path) : null
  }

  /**
   * Tarefas interrompidas que pertencem ao mesmo repositório/branch do lote.
   * A confirmação do worktree e da ref local é deliberadamente feita pela
   * camada Git: dados persistidos não provam que os artefatos ainda existem.
   */
  async integrationBranchesAwaitingBaseSync(batchId: string): Promise<IntegrationBranchSyncTarget[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { external_id: string | null; id: number; repo_path: string; base_branch: string }>>(
      `SELECT t.id,t.external_id,pmc.repo_path,b.base_branch
         FROM deploy_batches b
         INNER JOIN tarefas t
           ON t.projeto_id IN (
             SELECT deployed.projeto_id
               FROM deploy_requests dr
               INNER JOIN tarefas deployed ON deployed.id=dr.tarefa_id
              WHERE dr.batch_id=b.batch_id
           )
         INNER JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
         LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id
        WHERE b.batch_id=?
          AND pmc.repo_path=b.repo_path
          AND pmc.branch_trabalho=b.base_branch
          AND (
            (t.paused_at IS NOT NULL AND t.resource_wait_key IS NULL)
            OR f.clarification_pending_at IS NOT NULL
            OR EXISTS(SELECT 1 FROM tarefa_contextos_execucao cix
                        WHERE cix.tarefa_id=t.id AND cix.estado='awaiting_human')
            OR EXISTS(SELECT 1 FROM bloqueios bl
                        WHERE bl.tarefa_id=t.id AND bl.resolved_at IS NULL)
            OR EXISTS(SELECT 1 FROM subtarefas s
                        WHERE s.tarefa_id=t.id AND s.status='blocked')
          )`,
      [batchId],
    )
    return rows.map(row => ({
      taskId: String(row.external_id ?? row.id),
      repoPath: String(row.repo_path),
      baseBranch: String(row.base_branch),
    }))
  }

  async completeBatch(batchId: string, success: boolean, reason: string | null, source: QueueMessage): Promise<string[]> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const finalStatus = success ? 'succeeded' : 'failed'
      const [batch] = await connection.query<ResultSetHeader>(`UPDATE deploy_batches SET status=?,last_error=?,finished_at=NOW(),updated_at=NOW() WHERE batch_id=? AND status IN ('pending','running')`, [finalStatus, reason, batchId])
      if (batch.affectedRows === 0) { await connection.rollback(); return [] }
      const [requests] = await connection.query<Array<RowDataPacket & { external_id: string | null; task_id: number }>>(`SELECT t.external_id,dr.tarefa_id AS task_id FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id WHERE dr.batch_id=? FOR UPDATE`, [batchId])
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
        if (!success) {
          // Evento canônico para o Monitor-Resolvedor: todo bloqueio gera TASK_BLOCKED.
          const blocked = createTaskBlockedMessage({
            taskId,
            executionId: `${source.executionId}-block-${batchId}`,
            correlationId: source.correlationId ?? source.messageId,
            causationId: source.messageId,
            payload: {
              blockReason: 'deploy_failed',
              blockCommand: `motor-v3:deploy:${batchId}`,
              blockExcerpt: String(reason ?? 'Falha no deploy').slice(0, 500),
              batchId,
              databaseTaskId: Number(request.task_id),
            },
          })
          await this.insertOutbox(connection, blocked)
        }
      }
      if (success) {
        const taskIds = requests.map(row => Number(row.task_id))
        const dependentTasks = await this.findDependentTasks(connection, batchId, taskIds)
        for (const dependent of dependentTasks) {
          const taskId = String(dependent.external_id ?? dependent.id)
          const resumeMessage = createQueueMessage({
            type: 'TASK_RESUME_REQUESTED',
            taskId,
            executionId: `deploy-resume-${batchId}-${taskId}-${Date.now()}`,
            correlationId: source.correlationId ?? source.messageId,
            causationId: source.messageId,
            payload: { resumedBy: 'deploy_completion', batchId, dependencyTaskIds: taskIds.map(String) },
          })
          await this.insertOutbox(connection, resumeMessage)
        }
      }
      await this.insertPendingDispatches(connection)
      // Recupera o intervalo em que o processo morreu depois de adquirir o
      // lock. A condição impede remover o lock de outro batch.
      await connection.query(
        `UPDATE motor_deploy_lock SET locked=FALSE,locked_at=NULL,locked_by=NULL,reason=NULL
          WHERE id=1 AND locked_by=?`, [batchId],
      )
      await connection.commit()
      return requests.map(row => String(row.external_id ?? row.task_id))
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }

  /**
   * Busca tarefas dependentes elegíveis para retomada automática após deploy bem-sucedido.
   * Critérios: depends_on_task_id aponta para uma das tarefas do lote, paused_at IS NULL,
   * terminal_status IS NULL, analysis_started_at IS NULL, subtask_count = 0.
   * Idempotente: exclui tarefas que já possuem TASK_RESUME_REQUESTED no outbox para este batch.
   */
  private async findDependentTasks(
    connection: PoolConnection,
    batchId: string,
    deployedTaskIds: number[],
  ): Promise<Array<{ id: number; external_id: string | null }>> {
    if (deployedTaskIds.length === 0) return []
    const placeholders = deployedTaskIds.map(() => '?').join(',')
    const [rows] = await connection.query<Array<RowDataPacket & { id: number; external_id: string | null }>>(
      `SELECT t.id, t.external_id
         FROM tarefas t
         INNER JOIN tarefas dependency ON dependency.id = t.depends_on_task_id
         LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
        WHERE t.depends_on_task_id IN (${placeholders})
          AND dependency.projeto_id = t.projeto_id
          AND t.paused_at IS NULL
          AND (f.terminal_status IS NULL)
          AND (f.analysis_started_at IS NULL)
          AND (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) = 0
          AND NOT EXISTS (
            SELECT 1 FROM motor_outbox o
             WHERE o.task_id COLLATE utf8mb4_unicode_ci = COALESCE(t.external_id, CAST(t.id AS CHAR))
               AND o.type = 'TASK_RESUME_REQUESTED'
               AND JSON_UNQUOTE(JSON_EXTRACT(o.payload_json, '$.batchId')) = ?
          )
      `, [...deployedTaskIds, batchId])
    return rows
  }

  private async assertStillEligible(connection: PoolConnection, context: DeployTaskContext): Promise<void> {
    const [rows] = await connection.query<ContextRow[]>(`SELECT t.id,t.tipo,f.integration_confirmed_at,f.terminal_status,
      EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id=t.id AND b.resolved_at IS NULL) AS blocked
      FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id WHERE t.id=? FOR UPDATE`, [context.databaseTaskId])
    const task = rows[0]
    if (!task || String(task.tipo) !== 'desenvolvimento' || task.integration_confirmed_at == null || task.terminal_status !== 'completed' || Number(task.blocked) !== 0) throw new Error('Tarefa deixou de ser elegível para deploy')
  }

  private async insertOutbox(connection: PoolConnection, message: QueueMessage): Promise<void> {
    await insertOutboxMessage(connection, message, message.type === 'TASK_BLOCKED' ? 'motor.monitor' : 'motor.commands')
  }

  private async insertPendingDispatches(connection: PoolConnection): Promise<number> {
    const [groups] = await connection.query<Array<RowDataPacket & { repo_path: string; base_branch: string; requested_commit: string; task_id: string }>>(`
      SELECT dr.repo_path,dr.base_branch,dr.requested_commit,MIN(t.id) AS task_id
        FROM deploy_requests dr INNER JOIN tarefas t ON t.id=dr.tarefa_id
       WHERE dr.status='pending' GROUP BY dr.repo_path,dr.base_branch,dr.requested_commit`)
    for (const group of groups) {
      const message = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: String(group.task_id),
        executionId: `deploy-dispatch-recovery-${Date.now()}-${randomUUID()}`, payload: { repository: group.repo_path, baseBranch: group.base_branch, expectedCommit: group.requested_commit } })
      await this.insertOutbox(connection, message)
    }
    return groups.length
  }

  private mapBatch(row: BatchRow): DeployBatch {
    return { batchId: row.batch_id, repoPath: row.repo_path, baseBranch: row.base_branch, expectedCommit: row.expected_commit, status: row.status, remotePid: row.remote_pid, remoteStatusPath: row.remote_status_path, startedAt: row.started_at, workspacePath: row.workspace_path, gateJobId: row.gate_job_id == null ? null : Number(row.gate_job_id) }
  }
}
