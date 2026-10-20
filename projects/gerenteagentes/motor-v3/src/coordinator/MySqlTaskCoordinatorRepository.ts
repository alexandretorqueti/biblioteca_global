import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AnalysisClaimResult, AnalysisExecutionLeaseRepository, TaskCoordinatorRepository, TaskLifecycleStatus, TaskSnapshot, TaskDependencySnapshot, CapacityWaitProjection } from './TaskCoordinator.js'
import type { AnalysisOutcome } from '../analysis/AnalystReply.js'
import { DerivedTaskStatusResolver } from '../status/DerivedTaskStatus.js'
import { RealtimeMutationBoundary } from '../realtime/RealtimeMutationBoundary.js'
import type { RealtimeMutationPublisher } from '../realtime/RealtimeMutationPublisher.js'
import { providerFromModel, providerCapacityDecision } from '../execution/ProviderCapacity.js'
import { validateProjectSetupEvidence } from '../setup/ProjectSetupGate.js'

interface TaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  titulo: string
  descricao: string | null
  tipo: string | null
  agente_id: string | null
  project_slug: string | null
  repo_path: string | null
  paused_at: Date | string | null
  analysis_started_at: Date | string | null
  analysis_execution_id: string | null
  projeto_id: number | null
  auto_start: number | boolean
  setup_status: string | null
  terminal_status: string | null
  subtask_count: number | string
  blocked_count: number | string
  depends_on_task_id: number | string | null
  dependency_external_id: string | null
  dependency_id: number | null
  dependency_tipo: string | null
  dependency_terminal_status: string | null
  dependency_deploy_status: string | null
  capacity_wait_phase: 'analysis' | 'development' | null
  capacity_wait_reason_code: 'global_limit' | 'project_limit' | 'provider_limit' | null
  capacity_wait_limit_scope: 'global' | 'project' | 'provider' | null
  capacity_wait_limit_value: number | string | null
  capacity_wait_provider: string | null
}

interface DependencyRow extends RowDataPacket {
  dependency_external_id: string | null
  dependency_id: number
  dependency_tipo: string | null
  dependency_terminal_status: string | null
  dependency_deploy_status: string | null
}

/** Repositório MySQL do claim inicial de análise. */
export class MySqlTaskCoordinatorRepository implements TaskCoordinatorRepository, AnalysisExecutionLeaseRepository {
  private readonly statusResolver: DerivedTaskStatusResolver

  private readonly realtime: RealtimeMutationBoundary
  constructor(private readonly pool: Pool, realtime?: RealtimeMutationBoundary | RealtimeMutationPublisher) {
    this.realtime = realtime instanceof RealtimeMutationBoundary ? realtime : new RealtimeMutationBoundary(pool)
    this.statusResolver = new DerivedTaskStatusResolver(pool)
  }

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    const [rows] = await this.pool.query<TaskRow[]>(`
      SELECT
        t.id, t.external_id, t.titulo, t.descricao, t.tipo, pmc.repo_path, t.paused_at,
        t.auto_start, pc.setup_status,
        t.depends_on_task_id,
        COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug, '') AS agente_id,
        pc.slug AS project_slug,
        f.analysis_started_at, f.analysis_execution_id, f.terminal_status,
        f.capacity_wait_phase, f.capacity_wait_reason_code, f.capacity_wait_limit_scope,
        f.capacity_wait_limit_value, f.capacity_wait_provider,
        (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count,
        (SELECT COUNT(*) FROM bloqueios b
          WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS blocked_count,
        dep.external_id AS dependency_external_id,
        dep.id AS dependency_id,
        dep.tipo AS dependency_tipo,
        dep_f.terminal_status AS dependency_terminal_status,
        (SELECT CASE
           WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status = 'succeeded') THEN 'succeeded'
           WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status = 'failed') THEN 'failed'
           WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status IN ('pending','running')) THEN 'pending'
           ELSE NULL
         END) AS dependency_deploy_status
      FROM tarefas t
      LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
      LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
      LEFT JOIN agentes a ON a.id = pc.agente_id
      LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      LEFT JOIN tarefas dep ON dep.id = t.depends_on_task_id
      LEFT JOIN task_runtime_facts dep_f ON dep_f.tarefa_id = dep.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1
    `, [taskId, taskId])

    const row = rows[0]
    if (!row) return null
    const [dependencyRows] = await this.pool.query<DependencyRow[]>(`
      SELECT dep.external_id AS dependency_external_id, dep.id AS dependency_id,
             dep.tipo AS dependency_tipo, dep_f.terminal_status AS dependency_terminal_status,
             (SELECT CASE
                WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status = 'succeeded') THEN 'succeeded'
                WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status = 'failed') THEN 'failed'
                WHEN EXISTS(SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id = dep.id AND dr.status IN ('pending','running')) THEN 'pending'
                ELSE NULL
              END) AS dependency_deploy_status
        FROM tarefa_dependencias td
        INNER JOIN tarefas dep ON dep.id = td.depende_de_tarefa_id
        LEFT JOIN task_runtime_facts dep_f ON dep_f.tarefa_id = dep.id
       WHERE td.tarefa_id = ?
       ORDER BY td.id ASC`, [row.id])
    const dependencies: TaskDependencySnapshot[] = dependencyRows.map(dependency => ({
      taskId: String(dependency.dependency_external_id ?? dependency.dependency_id),
      taskType: dependency.dependency_tipo ? String(dependency.dependency_tipo) : null,
      terminalStatus: dependency.dependency_terminal_status ? String(dependency.dependency_terminal_status) : null,
      deployStatus: dependency.dependency_deploy_status ? String(dependency.dependency_deploy_status) : null,
    }))
    // Instalações anteriores à tabela N:N continuam funcionando enquanto a
    // coluna legada existir; a migration 0090 já a espelha na primeira linha.
    if (dependencies.length === 0 && row.depends_on_task_id != null) {
      dependencies.push({
        taskId: String(row.dependency_external_id ?? row.dependency_id ?? row.depends_on_task_id),
        taskType: row.dependency_tipo ? String(row.dependency_tipo) : null,
        terminalStatus: row.dependency_terminal_status ? String(row.dependency_terminal_status) : null,
        deployStatus: row.dependency_deploy_status ? String(row.dependency_deploy_status) : null,
      })
    }
    return {
      ...this.mapTask(row),
      status: await this.statusResolver.resolve(String(row.external_id ?? row.id)),
      dependsOnTaskId: row.depends_on_task_id != null
        ? String(row.dependency_external_id ?? row.dependency_id ?? row.depends_on_task_id)
        : null,
      dependencyTerminalStatus: row.dependency_terminal_status ? String(row.dependency_terminal_status) : null,
      dependencyDeployStatus: row.dependency_deploy_status ? String(row.dependency_deploy_status) : null,
      dependencyTaskType: row.dependency_tipo ? String(row.dependency_tipo) : null,
      dependencies,
      capacityWait: this.capacityWait(row),
    }
  }

  async claimAnalysis(taskId: string, executionId: string): Promise<AnalysisClaimResult> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this.lockTask(connection, taskId)
      if (!row || this.cannotStart(row)) {
        await connection.rollback()
        return false
      }
      if (this.setupBlocksTask(row)) {
        await this.persistSetupBlock(connection, row)
        await connection.commit()
        return false
      }

      // A mesma serialização usada pela reserva do DEV: as duas linhas de
      // configuração são bloqueadas antes de contar e fazer o claim. Assim,
      // duas retomadas concorrentes não conseguem observar a mesma vaga.
      const [limitRows] = await connection.query<Array<RowDataPacket & { chave: string; limite: number | string }>>(
        `SELECT chave, CAST(JSON_UNQUOTE(valor) AS UNSIGNED) AS limite
           FROM motor_configuracoes
          WHERE chave IN ('motor.max_workers', 'motor.max_workers_per_project')
          ORDER BY chave
          FOR UPDATE`,
      )
      const limits = new Map(limitRows.map(limit => [limit.chave, Math.max(1, Number(limit.limite ?? 1))]))
      const maxWorkers = limits.get('motor.max_workers') ?? 1
      const maxWorkersPerProject = limits.get('motor.max_workers_per_project') ?? 1
      const [globalRows] = await connection.query<Array<RowDataPacket & { total: number | string }>>(
        `SELECT COUNT(*) AS total
           FROM task_runtime_facts f
          WHERE f.analysis_started_at IS NOT NULL
            AND f.analysis_execution_id IS NOT NULL
            AND f.terminal_status IS NULL`,
      )
      if (Number(globalRows[0]?.total ?? 0) >= maxWorkers) {
        await this.recordCapacityWait(connection, row.id, 'analysis', 'global_limit', 'global', maxWorkers, null)
        await connection.commit()
        return 'capacity_waiting'
      }
      if (row.projeto_id != null) {
        const [projectRows] = await connection.query<Array<RowDataPacket & { total: number | string }>>(
          `SELECT COUNT(*) AS total
             FROM task_runtime_facts f
             INNER JOIN tarefas active_task ON active_task.id = f.tarefa_id
            WHERE f.analysis_started_at IS NOT NULL
              AND f.analysis_execution_id IS NOT NULL
              AND f.terminal_status IS NULL
              AND active_task.projeto_id = ?`,
          [row.projeto_id],
        )
        if (Number(projectRows[0]?.total ?? 0) >= maxWorkersPerProject) {
          await this.recordCapacityWait(connection, row.id, 'analysis', 'project_limit', 'project', maxWorkersPerProject, null)
          await connection.commit()
          return 'capacity_waiting'
        }
      }
      // Só resolve provider depois dos tetos gerais. Além de evitar trabalho
      // quando a vaga global já está ocupada, isso preserva a ordem histórica
      // das consultas para adaptadores legados sem configuração de projetos.
      let analysisProvider: string | null = null
      if (row.projeto_id != null) {
        const [modelRows] = await connection.query<Array<RowDataPacket & { model: string; provider: string | null }>>(
          `SELECT selection.model, selection.provider
             FROM tarefas t JOIN projetos_captados pc ON pc.id = t.projeto_id
             LEFT JOIN project_model_selection selection
               ON selection.project_slug = pc.slug AND selection.tipo = 'ANALYST' AND selection.enabled = 1
            WHERE t.id = ? ORDER BY selection.ordem ASC LIMIT 1`, [row.id],
        )
        analysisProvider = modelRows[0]?.provider || providerFromModel(modelRows[0]?.model)
      }
      const providerDecision = await providerCapacityDecision(connection, analysisProvider, 'analysis')
      if (!providerDecision.available) {
        await this.recordCapacityWait(connection, row.id, 'analysis', 'provider_limit', 'provider', providerDecision.limitValue ?? 0, analysisProvider)
        await connection.commit()
        return 'capacity_waiting'
      }
      // cannotStart() proves the canonical pre-claim projection is planned;
      // keeping this read-free also preserves the claim's single atomic SQL
      // update as the only conditional write.
      const before = 'planned' as const

      await connection.query(
        `INSERT INTO task_runtime_facts (tarefa_id, created_at, updated_at)
         VALUES (?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE tarefa_id = VALUES(tarefa_id)`,
        [row.id],
      )
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE task_runtime_facts
         SET analysis_started_at = NOW(), analysis_execution_id = ?, provider = ?, clarification_pending_at = NULL,
             capacity_wait_phase = NULL, capacity_wait_reason_code = NULL, capacity_wait_limit_scope = NULL,
             capacity_wait_limit_value = NULL, capacity_wait_provider = NULL, updated_at = NOW()
         WHERE tarefa_id = ? AND analysis_started_at IS NULL
           AND analysis_execution_id IS NULL AND terminal_status IS NULL`,
        [executionId, analysisProvider, row.id],
      )

      if (result.affectedRows !== 1) {
        await connection.rollback()
        return false
      }
      const after = 'analyzing' as const
      await this.realtime.append(connection, row.id, before, { after })
      await connection.commit()
      return true
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async releaseAnalysisClaim(taskId: string, executionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE task_runtime_facts f
       INNER JOIN tarefas t ON t.id = f.tarefa_id
       SET f.analysis_started_at = NULL,
           f.analysis_execution_id = NULL,
           f.updated_at = NOW()
       WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
         AND f.analysis_execution_id = ?`,
      [taskId, taskId, executionId],
    )
  }

  async acquireAnalysisLease(taskId: string, executionId: string, ttlMs: number): Promise<void> {
    const ttlSeconds = this.leaseSeconds(ttlMs)
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO motor_active_executions
         (execution_id, tarefa_id, subtarefa_id, phase, started_at, heartbeat_at, expires_at)
       SELECT ?, t.id, NULL, 'analysis', NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND)
         FROM tarefas t
         INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
        WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
          AND f.analysis_execution_id = ?
        LIMIT 1
       ON DUPLICATE KEY UPDATE heartbeat_at = NOW(), expires_at = VALUES(expires_at), phase = 'analysis'`,
      [executionId, ttlSeconds, taskId, taskId, executionId],
    )
    if (result.affectedRows === 0) throw new Error(`Não foi possível adquirir lease de análise para ${taskId}`)
  }

  async heartbeatAnalysisLease(executionId: string, ttlMs: number): Promise<void> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE motor_active_executions
          SET heartbeat_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
        WHERE execution_id = ? AND phase = 'analysis'`,
      [this.leaseSeconds(ttlMs), executionId],
    )
    if (result.affectedRows !== 1) throw new Error(`Lease de análise ausente para ${executionId}`)
  }

  async releaseAnalysisLease(executionId: string): Promise<void> {
    await this.pool.query('DELETE FROM motor_active_executions WHERE execution_id = ? AND phase = \'analysis\'', [executionId])
  }

  async persistAnalysis(taskId: string, executionId: string, outcome: AnalysisOutcome): Promise<void> {
    const connection = await this.pool.getConnection()
    let createdSubtaskIds: number[] = []
    let committedTaskId: number | null = null
    try {
      await connection.beginTransaction()
      const [taskRows] = await connection.query<TaskRow[]>(
        `SELECT t.id, t.tipo, t.external_id, t.projeto_id FROM tarefas t
         INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
         WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
           AND f.analysis_execution_id = ?
         LIMIT 1 FOR UPDATE`,
        [taskId, taskId, executionId],
      )
      const databaseTaskId = taskRows[0]?.id
      if (!databaseTaskId) throw new Error(`Claim de análise não encontrado para ${taskId}`)
      committedTaskId = databaseTaskId
      // persistAnalysis is invoked only after a successful analysis claim.
      const before = 'analyzing' as const

      if (outcome.kind === 'questions') {
        const chatText = JSON.stringify({ summary: outcome.summary, questions: outcome.questions })
        const createdAt = new Date().toISOString()
        const [chatInsert] = await connection.query<ResultSetHeader>(
          `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at)
           VALUES (?, 'analyst', ?, NOW())`,
          [databaseTaskId, chatText],
        )
        await this.realtime.appendChatMessage(connection, databaseTaskId, {
          id: Number(chatInsert.insertId), role: 'analyst', texto: chatText, createdAt,
        })
        await connection.query(
          `UPDATE task_runtime_facts
             SET clarification_pending_at = NOW(), updated_at = NOW()
           WHERE tarefa_id = ?`,
          [databaseTaskId],
        )
      } else if (outcome.kind === 'verification') {
        if (String(taskRows[0]?.external_id ?? taskId).startsWith('setup-')) {
          const candidate = outcome.evidence.map(value => {
            try { return JSON.parse(value) as unknown } catch { return null }
          }).find(value => value !== null)
          const gate = validateProjectSetupEvidence(candidate)
          if (!gate.ok) {
            await connection.query(
              `UPDATE projetos_captados SET setup_status='failed', setup_error=?, updated_at=NOW()
                WHERE id=?`, [`Setup rejeitado pelo gate: ${gate.reasons.join('; ')}`, taskRows[0]?.projeto_id],
            )
            throw new Error(`Setup rejeitado pelo gate: ${gate.reasons.join('; ')}`)
          }
          await connection.query(
            `UPDATE projetos_captados SET setup_status='verified', setup_error=NULL,
                    setup_verified_at=NOW(), setup_evidence=?, updated_at=NOW()
              WHERE slug = ?`, [JSON.stringify(gate.evidence), String(taskId).replace(/^setup-/, '')],
          )
        }
        const chatText = JSON.stringify({ kind: 'verification', verdict: outcome.verdict, summary: outcome.summary, evidence: outcome.evidence })
        const createdAt = new Date().toISOString()
        const [chatInsert] = await connection.query<ResultSetHeader>(
          `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at)
           VALUES (?, 'analyst', ?, NOW())`,
          [databaseTaskId, chatText],
        )
        await this.realtime.appendChatMessage(connection, databaseTaskId, {
          id: Number(chatInsert.insertId), role: 'analyst', texto: chatText, createdAt,
        })
        await connection.query(
          `INSERT INTO task_runtime_facts
             (tarefa_id, terminal_status, terminal_at, integration_confirmed_at, created_at, updated_at)
           VALUES (?, 'completed', NOW(), NOW(), NOW(), NOW())
           ON DUPLICATE KEY UPDATE terminal_status='completed', terminal_at=NOW(),
             integration_confirmed_at=NOW(), updated_at=NOW()`,
          [databaseTaskId],
        )
        await this.realtime.append(connection, databaseTaskId, before, { after: 'closed' })
      } else {
        const [existing] = await connection.query<RowDataPacket[]>(
          'SELECT id FROM subtarefas WHERE tarefa_id = ? LIMIT 1 FOR UPDATE', [databaseTaskId],
        )
        if (existing.length === 0) {
          const ids = new Map<number, number>()
          for (const subtask of outcome.subtasks) {
            const [result] = await connection.query<ResultSetHeader>(
              `INSERT INTO subtarefas
                (tarefa_id, seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered, depends_on_subtask_ids, completion_kind, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
              [databaseTaskId, subtask.seq, subtask.titulo, subtask.scope,
                JSON.stringify(subtask.acceptanceCriteria), JSON.stringify(subtask.deliverables),
                JSON.stringify(subtask.requirementsCovered), JSON.stringify([]), subtask.completionKind],
            )
            ids.set(subtask.seq, result.insertId)
            createdSubtaskIds.push(result.insertId)
            if (subtask.completionKindInference) {
              await connection.query(
                `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
                 VALUES (?, ?, 'completion_kind_inferred', 'motor-v3', 'motor', ?, NOW())`,
                [databaseTaskId, taskId, JSON.stringify({
                  subtask: { seq: subtask.seq, titulo: subtask.titulo },
                  completionKind: subtask.completionKind,
                  reason: subtask.completionKindInference.reason,
                })],
              )
            }
          }
          for (const subtask of outcome.subtasks) {
            const dependencyIds = subtask.dependsOn.map(seq => ids.get(seq)).filter((id): id is number => Boolean(id))
            await connection.query(
              `UPDATE subtarefas SET depends_on_subtask_id = ?, depends_on_subtask_ids = ?
               WHERE tarefa_id = ? AND seq = ?`,
              [dependencyIds[0] ?? null, JSON.stringify(dependencyIds), databaseTaskId, subtask.seq],
            )
          }
          await connection.query('UPDATE tarefas SET plan_coverage = ? WHERE id = ?', [JSON.stringify(outcome.coverage), databaseTaskId])
          const afterPlan = 'ready' as const
          for (const subtaskId of createdSubtaskIds) {
            await this.realtime.append(connection, databaseTaskId, before, {
              type: 'subtask.created', subtaskId, subtaskStatus: 'pending', after: before,
            })
          }
          await this.realtime.append(connection, databaseTaskId, before, { after: afterPlan })
        }
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async lockTask(connection: PoolConnection, taskId: string): Promise<TaskRow | null> {
    const [rows] = await connection.query<TaskRow[]>(`
      SELECT
        t.id, t.external_id, t.projeto_id, t.paused_at, t.auto_start, pc.setup_status,
        f.analysis_started_at, f.analysis_execution_id, f.terminal_status,
        (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count,
        (SELECT COUNT(*) FROM bloqueios b
          WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS blocked_count
      FROM tarefas t
      LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
      LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1
      FOR UPDATE
    `, [taskId, taskId])
    return rows[0] ?? null
  }

  private cannotStart(row: Pick<TaskRow, 'paused_at' | 'analysis_started_at' | 'analysis_execution_id' | 'terminal_status' | 'subtask_count' | 'blocked_count'>): boolean {
    return row.paused_at != null
      || row.analysis_started_at != null
      || row.analysis_execution_id != null
      || row.terminal_status != null
      || Number(row.subtask_count) > 0
      || Number(row.blocked_count) > 0
  }

  private setupBlocksTask(row: Pick<TaskRow, 'auto_start' | 'setup_status' | 'external_id'>): boolean {
    return Boolean(row.auto_start) && !String(row.external_id ?? '').startsWith('setup-') && row.setup_status !== 'verified'
  }

  private async persistSetupBlock(connection: PoolConnection, row: Pick<TaskRow, 'id' | 'setup_status'>): Promise<void> {
    const reason = `setup_not_verified: status=${row.setup_status ?? 'pending'}`
    await connection.query(
      `INSERT INTO bloqueios (tarefa_id, block_reason, block_excerpt, blocked_at, created_at)
       SELECT ?, ?, ?, NOW(), NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM bloqueios WHERE tarefa_id = ? AND resolved_at IS NULL AND block_reason LIKE 'setup_not_verified:%'
        )`, [row.id, reason, 'Tarefa auto_start retida até setup do projeto ser verificado', row.id],
    )
  }

  private mapTask(row: TaskRow): TaskSnapshot {
    const terminal = row.terminal_status != null
    const paused = row.paused_at != null
    const status = terminal
      ? this.mapStatus(row.terminal_status)
      : paused
        ? 'paused'
        : row.analysis_started_at != null
          ? 'running'
          : 'planned'
    return {
      taskId: String(row.external_id ?? row.id),
      title: String(row.titulo ?? ''),
      description: String(row.descricao ?? ''),
      taskType: String(row.tipo ?? 'desenvolvimento'),
      agentId: String(row.agente_id ?? ''),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      repoPath: String(row.repo_path ?? ''),
      status,
      paused,
      terminal,
      analysisStartedAt: row.analysis_started_at ? new Date(row.analysis_started_at).toISOString() : null,
      analysisExecutionId: row.analysis_execution_id ? String(row.analysis_execution_id) : null,
      subtaskCount: Number(row.subtask_count ?? 0),
    }
  }

  private capacityWait(row: TaskRow): CapacityWaitProjection | null {
    if (!row.capacity_wait_phase || !row.capacity_wait_reason_code || !row.capacity_wait_limit_scope || row.capacity_wait_limit_value == null) return null
    return {
      phase: row.capacity_wait_phase,
      reasonCode: row.capacity_wait_reason_code,
      limitScope: row.capacity_wait_limit_scope,
      limitValue: Number(row.capacity_wait_limit_value),
      provider: row.capacity_wait_provider ? String(row.capacity_wait_provider) : null,
    }
  }

  private async recordCapacityWait(
    connection: PoolConnection, taskId: number, phase: 'analysis' | 'development',
    reasonCode: 'global_limit' | 'project_limit' | 'provider_limit',
    limitScope: 'global' | 'project' | 'provider', limitValue: number, provider: string | null,
  ): Promise<void> {
    await connection.query(
      `INSERT INTO task_runtime_facts (tarefa_id, created_at, updated_at)
       VALUES (?, NOW(), NOW()) ON DUPLICATE KEY UPDATE tarefa_id = VALUES(tarefa_id)`, [taskId],
    )
    await connection.query(
      `UPDATE task_runtime_facts SET capacity_wait_phase=?, capacity_wait_reason_code=?,
       capacity_wait_limit_scope=?, capacity_wait_limit_value=?, capacity_wait_provider=?, updated_at=NOW()
       WHERE tarefa_id=?`, [phase, reasonCode, limitScope, limitValue, provider, taskId],
    )
  }

  private mapStatus(value: string | null): TaskLifecycleStatus {
    switch (String(value ?? '').toLowerCase()) {
      case 'running': return 'running'
      case 'paused': return 'paused'
      case 'blocked': return 'blocked'
      case 'cancelled': case 'canceled': return 'cancelled'
      case 'completed': case 'done': case 'verified': return 'completed'
      case 'failed': case 'error': return 'failed'
      default: return 'planned'
    }
  }

  private leaseSeconds(ttlMs: number): number {
    return Math.max(1, Math.ceil(ttlMs / 1000))
  }
}
