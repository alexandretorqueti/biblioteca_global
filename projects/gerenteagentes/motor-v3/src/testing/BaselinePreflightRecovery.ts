import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { PrimitiveContext } from '../primitives/types.js'
import type { QueueMessage } from '../queue/index.js'
import type { SubtaskExecutionContext } from '../execution/DevelopmentExecutionRepository.js'
import type { PreparedWorktree } from '../execution/GitWorktreePreparer.js'
import type { WorkerLauncher } from '../worker-launcher/index.js'
import type { TestGateOrchestrator } from './TestGateOrchestrator.js'
import type { TestRunResult } from './TestGateService.js'

const execFileAsync = promisify(execFile)

export interface PreflightRecoveryResult {
  success: boolean
  baseline?: TestRunResult
  integrationCommit?: string
  error?: string
}

/** Corrige um baseline vermelho na integração antes de qualquer sessão DEV. */
export class BaselinePreflightRecovery {
  constructor(
    private readonly pool: Pool,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly consoleApi: unknown,
    private readonly db: unknown,
    private readonly testGate: TestGateOrchestrator,
  ) {}

  async recover(
    execution: SubtaskExecutionContext,
    integration: PreparedWorktree,
    failedBaseline: TestRunResult,
    source: QueueMessage,
  ): Promise<PreflightRecoveryResult> {
    const models = await this.models(execution.projectSlug)
    if (models.length === 0) return { success: false, error: 'Baseline vermelho e nenhum modelo MONITOR está habilitado para o projeto' }
    const context: PrimitiveContext = {
      taskId: execution.taskId,
      databaseTaskId: execution.databaseTaskId,
      projectId: execution.projectId,
      subtaskId: execution.subtaskId,
      executionId: source.executionId,
      generation: 1,
      projectSlug: execution.projectSlug,
      repoPath: execution.repoPath,
      worktreePath: integration.integrationPath,
      branchName: integration.integrationBranch,
      baseCommitSha: integration.baseCommit,
      buildCommand: execution.buildCommand,
      testCommand: execution.testCommand,
      agentId: execution.agentId,
      db: this.db,
      consoleApi: this.consoleApi,
      logger: console,
    }
    const result = await this.worker.executeTask(
      context,
      this.prompt(execution, integration, failedBaseline),
      models,
      undefined,
      async gateContext => {
        const run = await this.testGate.request({
          projectId: execution.projectId,
          taskDatabaseId: execution.databaseTaskId,
          subtaskId: execution.subtaskId,
          phase: 'monitor_recovery',
          commitSha: gateContext.baseCommitSha ?? integration.baseCommit,
          baseCommitSha: integration.baseCommit,
          branchName: integration.integrationBranch,
          workspacePath: integration.integrationPath,
          buildCommand: execution.buildCommand,
          testCommand: execution.testCommand,
        }, source)
        return {
          success: run.status === 'passed',
          runId: run.id,
          newFailureCount: run.failures.length,
          preExistingFailureCount: 0,
          resolvedFailureCount: failedBaseline.failures.length,
          ...(run.status === 'passed' ? {} : { error: this.failureSummary(run) }),
        }
      },
    )
    if (!result.success) return { success: false, error: result.error ?? 'Monitor não deixou o baseline verde' }

    await execFileAsync('git', ['add', '-A'], { cwd: integration.integrationPath })
    const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: integration.integrationPath })
    if (!staged.trim()) return { success: false, error: 'Monitor informou conclusão, mas não produziu correção na integração' }
    await execFileAsync('git', ['commit', '-m', `motor-v3: corrigir baseline da tarefa ${execution.taskId}`], { cwd: integration.integrationPath })
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: integration.integrationPath })
    const integrationCommit = commit.trim()
    const baseline = await this.testGate.request({
      projectId: execution.projectId,
      taskDatabaseId: execution.databaseTaskId,
      subtaskId: execution.subtaskId,
      phase: 'baseline',
      commitSha: integrationCommit,
      baseCommitSha: integrationCommit,
      branchName: integration.integrationBranch,
      workspacePath: integration.integrationPath,
      buildCommand: execution.buildCommand,
      testCommand: execution.testCommand,
    }, source)
    return baseline.status === 'passed'
      ? { success: true, baseline, integrationCommit }
      : { success: false, baseline, integrationCommit, error: `Baseline continuou vermelho após a correção do Monitor: ${this.failureSummary(baseline)}` }
  }

  private async models(projectSlug: string): Promise<string[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { model: string }>>(
      `SELECT model FROM project_model_selection WHERE project_slug=? AND tipo='MONITOR' AND enabled=1 ORDER BY ordem`, [projectSlug],
    )
    return rows.map(row => String(row.model)).filter(Boolean)
  }

  private prompt(execution: SubtaskExecutionContext, integration: PreparedWorktree, baseline: TestRunResult): string {
    return [
      'Corrija o baseline antes de o programador receber a subtarefa funcional.',
      `Tarefa: ${execution.taskTitle} (${execution.taskId})`,
      `Workspace de integração autorizado: ${integration.integrationPath}`,
      `Branch de integração: ${integration.integrationBranch}`,
      `Commit-base: ${integration.baseCommit}`,
      `Build: ${execution.buildCommand}`,
      `Testes: ${execution.testCommand}`,
      'Trabalhe exclusivamente na integração acima. Não implemente o requisito funcional da subtarefa.',
      'Faça a menor correção segura para deixar o gate completo verde. Não faça push nem deploy.',
      this.failureSummary(baseline),
      'Ao deixar o gate verde, responda com ::DONE::.',
    ].join('\n\n')
  }

  private failureSummary(run: TestRunResult): string {
    return run.failures.length === 0
      ? 'O comando de baseline falhou sem falhas estruturadas; inspecione a saída completa no workspace.'
      : run.failures.map((failure, index) => `${index + 1}. ${failure.suite}: ${failure.normalizedMessage}`).join('\n')
  }
}
