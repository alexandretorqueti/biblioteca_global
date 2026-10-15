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
  sessionHandedOff?: boolean
}

export async function persistBaselineCorrection(
  integrationPath: string,
  baseCommit: string,
  message: string,
  baseBranch?: string,
): Promise<string | null> {
  await execFileAsync('git', ['add', '-A'], { cwd: integrationPath })
  const { stdout: staged } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: integrationPath })
  if (staged.trim()) await execFileAsync('git', ['commit', '-m', message], { cwd: integrationPath })

  const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: integrationPath })
  const integrationCommit = commit.trim()
  if (integrationCommit !== baseCommit) return integrationCommit
  // O re-preparo do worktree registra como commit-base o HEAD atual, que pode
  // já conter a correção commitada por uma sessão anterior (handoff). Se a
  // branch de integração está adiante da branch base da tarefa, a correção
  // existe; o gate de baseline a seguir continua validando o estado real.
  if (baseBranch && await isAheadOfBaseBranch(integrationPath, baseBranch)) return integrationCommit
  return null
}

async function isAheadOfBaseBranch(integrationPath: string, baseBranch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${baseBranch}..HEAD`], { cwd: integrationPath })
    return Number(stdout.trim()) > 0
  } catch {
    return false
  }
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
      sessionKind: 'baseline_fix',
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
      await this.prompt(execution, integration, failedBaseline),
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
    if (result.sessionHandedOff) return { success: false, sessionHandedOff: true, error: result.error }
    if (!result.success) return { success: false, error: result.error ?? 'Monitor não deixou o baseline verde' }

    const completed = await this.complete(execution, integration, source)
    await this.closeSession(context.sessionKey, completed.success)
    return completed
  }

  /** Pós-processamento idempotente da sessão entregue ao reconciliador. */
  async completeHandoff(
    execution: SubtaskExecutionContext,
    integration: PreparedWorktree,
    source: QueueMessage,
  ): Promise<PreflightRecoveryResult> {
    return this.complete(execution, integration, source)
  }

  private async complete(
    execution: SubtaskExecutionContext,
    integration: PreparedWorktree,
    source: QueueMessage,
  ): Promise<PreflightRecoveryResult> {

    const integrationCommit = await persistBaselineCorrection(
      integration.integrationPath,
      integration.baseCommit,
      `motor-v3: corrigir baseline da tarefa ${execution.taskId}`,
      execution.baseBranch,
    )
    if (!integrationCommit) return { success: false, error: 'Monitor informou conclusão, mas não produziu correção na integração' }
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

  private async prompt(execution: SubtaskExecutionContext, integration: PreparedWorktree, baseline: TestRunResult): Promise<string> {
    const { stdout: dirty } = await execFileAsync('git', ['status', '--short'], { cwd: integration.integrationPath })
    return [
      'Corrija o baseline antes de o programador receber a subtarefa funcional.',
      `Tarefa: ${execution.taskTitle} (${execution.taskId})`,
      `Workspace de integração autorizado: ${integration.integrationPath}`,
      `Branch de integração: ${integration.integrationBranch}`,
      `Commit-base: ${integration.baseCommit}`,
      `Build: ${execution.buildCommand}`,
      `Testes: ${execution.testCommand}`,
      'Trabalhe exclusivamente na integração acima. Não implemente o requisito funcional da subtarefa.',
      ...(dirty.trim() ? [
        'ATENÇÃO: o worktree já contém mudanças não commitadas de uma tentativa anterior. Preserve-as e continue sobre esse estado; não descarte nem sobrescreva cegamente.',
        `Mudanças existentes:\n${dirty.trim()}`,
      ] : []),
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

  private async closeSession(sessionKey: string | undefined, success: boolean): Promise<void> {
    if (!sessionKey) return
    await this.pool.query(
      `UPDATE motor_agent_sessions
          SET status=?, close_reason=?, closed_at=NOW(), last_activity_at=NOW()
        WHERE session_key=? AND purpose='baseline_fix' AND status='active'`,
      [success ? 'completed' : 'failed', success ? 'baseline_fix_completed' : 'baseline_fix_failed', sessionKey],
    )
  }
}
