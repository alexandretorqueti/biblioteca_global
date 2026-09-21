import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { WorkerLauncher } from '../worker-launcher/index.js'
import type { GitWorktreePreparer } from '../execution/GitWorktreePreparer.js'
import { GitVerificationIntegrator } from '../execution/GitVerificationIntegrator.js'
import type { SubtaskExecutionContext } from '../execution/DevelopmentExecutionRepository.js'
import type { TestGateService } from './TestGateService.js'

interface RecoveryRow extends RowDataPacket {
  recovery_id: number
  project_id: number
  task_database_id: number
  task_id: string
  task_title: string
  project_slug: string
  repo_path: string
  branch_trabalho: string
  build_command: string
  unit_test_command: string
  agent_id: string
  source_test_run_id: number
  failures_text: string | null
}

export class TestRecoveryConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly worktrees: GitWorktreePreparer,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly consoleApi: unknown,
    private readonly db: unknown,
    private readonly testGate: TestGateService,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== 'TEST_BASELINE_RECOVERY_REQUESTED') return
    const recoveryId = Number(message.payload.recoveryId)
    const recovery = await this.load(recoveryId)
    if (!recovery) return
    await this.pool.query(`UPDATE test_recovery_attempts SET status='running', attempt_count=attempt_count+1, started_at=NOW(3) WHERE id=? AND status='pending'`, [recoveryId])
    try {
      const models = await this.models(recovery.project_slug)
      if (models.length === 0) {
        return await this.fail(recovery, 'Nenhum modelo MONITOR está habilitado para o projeto. A recuperação automática não pode ser iniciada com um modelo implícito.')
      }
      const workspace = await this.worktrees.prepare({
        taskId: `${recovery.task_id}-test-recovery-${recoveryId}`,
        subtaskId: recoveryId,
        repoPath: recovery.repo_path,
        baseBranch: recovery.branch_trabalho,
      })
      await this.pool.query(`UPDATE test_recovery_attempts SET workspace_path=?, branch_name=? WHERE id=?`, [workspace.path, workspace.branch, recoveryId])
      const context: PrimitiveContext = {
        taskId: recovery.task_id, databaseTaskId: recovery.task_database_id, projectId: recovery.project_id,
        subtaskId: recoveryId, executionId: message.executionId, generation: 1, projectSlug: recovery.project_slug,
        repoPath: recovery.repo_path, worktreePath: workspace.path, branchName: workspace.branch,
        baseCommitSha: workspace.baseCommit, buildCommand: recovery.build_command, testCommand: recovery.unit_test_command,
        agentId: recovery.agent_id, db: this.db, consoleApi: this.consoleApi, logger: console,
      }
      const result = await this.worker.executeTask(context, this.prompt(recovery), models, undefined, async (gateContext) => {
        const run = await this.testGate.run({
          projectId: recovery.project_id, taskDatabaseId: recovery.task_database_id, phase: 'monitor_recovery',
          baselineRunId: recovery.source_test_run_id, commitSha: gateContext.baseCommitSha ?? workspace.baseCommit,
          baseCommitSha: workspace.baseCommit, branchName: workspace.branch, workspacePath: workspace.path,
          buildCommand: recovery.build_command, testCommand: recovery.unit_test_command,
        })
        return {
          success: run.status === 'passed', runId: run.id, newFailureCount: run.failures.length,
          preExistingFailureCount: run.preExistingFailures.length, resolvedFailureCount: run.resolvedFailures.length,
          ...(run.status === 'passed' ? {} : { error: `O gate completo ainda possui ${run.failures.length} falha(s):\n${run.failures.map((failure, index) => `${index + 1}. ${failure.suite}: ${failure.normalizedMessage}`).join('\n')}` }),
        }
      })
      if (!result.success) return await this.fail(recovery, result.error ?? 'Monitor esgotou as tentativas sem deixar o gate verde')
      const integrator = new GitVerificationIntegrator(this.worktrees)
      await integrator.verifyAndIntegrate(this.integrationContext(recovery, workspace))
      await this.pool.query(
        `UPDATE test_recovery_attempts SET status='resolved', recovery_test_run_id=?, resolution=?, finished_at=NOW(3), updated_at=NOW(3) WHERE id=?`,
        [result.postDevRunId ?? null, result.response ?? 'Gate completo aprovado pelo Monitor', recoveryId],
      )
    } catch (error) {
      await this.fail(recovery, error instanceof Error ? error.message : String(error))
    }
  }

  private async load(recoveryId: number): Promise<RecoveryRow | null> {
    const [rows] = await this.pool.query<RecoveryRow[]>(
      `SELECT r.id recovery_id, r.projeto_id project_id, t.id task_database_id,
              COALESCE(t.external_id, CAST(t.id AS CHAR)) task_id, t.titulo task_title,
              pc.slug project_slug, pmc.repo_path, pmc.branch_trabalho, pmc.build_command,
              pmc.unit_test_command, COALESCE(NULLIF(a.openclaw_agent_id,''), pc.slug) agent_id,
              r.source_test_run_id,
              GROUP_CONCAT(CONCAT(tf.suite, ': ', tf.normalized_message) SEPARATOR '\n') failures_text
         FROM test_recovery_attempts r
         JOIN tarefas t ON t.id=r.source_tarefa_id
         JOIN projetos_captados pc ON pc.id=t.projeto_id
         JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
         LEFT JOIN agentes a ON a.id=pc.agente_id
         LEFT JOIN test_failures tf ON tf.test_run_id=r.source_test_run_id AND tf.classification='pre_existing'
        WHERE r.id=? AND r.status='pending'
        GROUP BY r.id, t.id, t.external_id, t.titulo, pc.slug, pmc.repo_path, pmc.branch_trabalho,
                 pmc.build_command, pmc.unit_test_command, a.openclaw_agent_id, r.source_test_run_id`, [recoveryId],
    )
    return rows[0] ?? null
  }

  private async models(projectSlug: string): Promise<string[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { model: string }>>(
      `SELECT model FROM project_model_selection WHERE project_slug=? AND tipo='MONITOR' AND enabled=1 ORDER BY ordem`, [projectSlug],
    )
    return rows.map(row => String(row.model)).filter(Boolean)
  }

  private prompt(recovery: RecoveryRow): string {
    return [
      'Corrija as falhas de teste preexistentes abaixo. Esta é uma recuperação pós-tarefa executada pelo Monitor.',
      `Tarefa de origem: ${recovery.task_title} (${recovery.task_id})`,
      'Não altere o requisito funcional já entregue. Investigue a causa, faça a menor correção segura e rode validações proporcionais.',
      recovery.failures_text ?? 'Consulte o gate no workspace para obter os erros.',
      'Não faça push nem deploy. Ao deixar o gate completo verde, responda com ::DONE::.',
    ].join('\n\n')
  }

  private integrationContext(recovery: RecoveryRow, workspace: { path: string; branch: string; baseCommit: string }): SubtaskExecutionContext {
    return {
      taskId: recovery.task_id, databaseTaskId: recovery.task_database_id, projectId: recovery.project_id,
      subtaskId: recovery.recovery_id, seq: recovery.recovery_id, taskTitle: recovery.task_title,
      taskDescription: '', title: 'Recuperação de testes preexistentes', scope: '', acceptanceCriteria: [], deliverables: [],
      projectSlug: recovery.project_slug, repoPath: recovery.repo_path, baseBranch: recovery.branch_trabalho,
      buildCommand: recovery.build_command, testCommand: recovery.unit_test_command, agentId: recovery.agent_id,
      workspacePath: workspace.path, workspaceBranch: workspace.branch, workspaceBaseCommit: workspace.baseCommit,
    }
  }

  private async fail(recovery: RecoveryRow, diagnosis: string): Promise<void> {
    const message = [
      'O Monitor tentou corrigir as falhas de teste preexistentes após a conclusão funcional da tarefa, mas não conseguiu deixar o gate verde.',
      '', 'Diagnóstico:', diagnosis.slice(0, 6000), '',
      'A tarefa funcional permanece concluída, porém o deploy está bloqueado até que o gate de testes seja aprovado.',
    ].join('\n')
    const [inserted] = await this.pool.query<any>(`INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'assistant', ?, NOW())`, [recovery.task_database_id, message])
    await this.pool.query(
      `UPDATE test_recovery_attempts SET status='awaiting_user', diagnosis=?, user_message_id=?, finished_at=NOW(3), updated_at=NOW(3) WHERE id=?`,
      [diagnosis.slice(0, 60_000), inserted.insertId ?? null, recovery.recovery_id],
    )
  }
}
