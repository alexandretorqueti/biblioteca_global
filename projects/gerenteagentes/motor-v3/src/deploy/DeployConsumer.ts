import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { CommandPolicyResolver, type CommandPolicyRepository, type OperationLogger } from '../commands/index.js'
import { mapHostRepoPathToContainer } from '../execution/GitWorktreePreparer.js'
import type { QueueMessage } from '../queue/index.js'
import { TestGateOrchestrator } from '../testing/index.js'
import { DeployRepository, type DeployTaskContext } from './DeployRepository.js'
import { RemoteBlueGreenDeployer } from './RemoteBlueGreenDeployer.js'

const execFileAsync = promisify(execFile)

/** Consumidor governado: comandos de deploy -> primitives auditáveis. */
export class DeployConsumer {
  constructor(
    private readonly repository: DeployRepository,
    private readonly gate: TestGateOrchestrator,
    private readonly remote: RemoteBlueGreenDeployer,
    private readonly logger?: OperationLogger,
    private readonly commandPolicies?: CommandPolicyRepository,
    private readonly hostRepoRoot = process.env.DEPLOY_REPO_HOST,
    private readonly script = process.env.MOTOR_DEPLOY_SCRIPT || 'projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh',
    private readonly timeoutMs = Number(process.env.MOTOR_DEPLOY_TIMEOUT_MS || 1_800_000),
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type === 'DEPLOY_REQUESTED') return this.accept(message)
    if (message.type === 'DEPLOY_BATCH_DISPATCH_REQUESTED') return this.dispatch(message)
    if (message.type === 'DEPLOY_RECONCILIATION_REQUESTED') return this.reconcile(message)
  }

  async requestReconciliation(): Promise<number> { return this.repository.enqueueReconciliationForRunning() }

  private async accept(message: QueueMessage): Promise<void> {
    const operationId = randomUUID()
    await this.log(operationId, 1, 'received', 'executed', message, { commandCode: 'C10_DEPLOY_REQUESTED' })
    if (!await this.govern(operationId, message, 'A30_ACCEPT_DEPLOY_REQUEST')) return
    const raw = await this.repository.getEligibleTask(message.taskId)
    if (!raw) return this.reject(operationId, message, 'task_not_found')
    const context = await this.integrationContext(raw)
    const result = await this.gate.request({ projectId: context.projectId, taskDatabaseId: context.databaseTaskId, phase: 'pre_deploy', commitSha: context.integrationCommit, baseCommitSha: context.integrationCommit, branchName: context.integrationBranch, workspacePath: context.integrationPath, buildCommand: context.buildCommand, testCommand: context.testCommand }, message)
    await this.log(operationId, 3, 'primitive', result.status === 'passed' && result.failures.length === 0 ? 'succeeded' : 'failed', message, { primitiveCode: 'run_pre_deploy_gate', result: { testRunId: result.id, status: result.status, failures: result.failures.length } })
    if (result.status !== 'passed' || result.failures.length > 0) return this.reject(operationId, message, 'pre_deploy_gate_failed')
    const accepted = await this.repository.acceptRequest(context, message)
    await this.log(operationId, 4, 'primitive', 'succeeded', message, { primitiveCode: 'upsert_deploy_request', result: { requestId: accepted.requestId, dispatchMessageId: accepted.dispatch.messageId } })
    await this.log(operationId, 5, 'completed', 'succeeded', message, { actionCode: 'A30_ACCEPT_DEPLOY_REQUEST', result: { requestId: accepted.requestId } })
  }

  private async dispatch(message: QueueMessage): Promise<void> {
    const operationId = randomUUID(); await this.log(operationId, 1, 'received', 'executed', message, { commandCode: 'C11_DEPLOY_BATCH_DISPATCH_REQUESTED' })
    if (!await this.govern(operationId, message, 'A31_DISPATCH_DEPLOY_BATCH')) return
    const claimed = await this.repository.claimBatch(message)
    if (!claimed) return this.log(operationId, 2, 'completed', 'skipped', message, { reasonCode: 'no_compatible_pending_batch' })
    try {
      await this.remote.assertReady(); await this.promote(claimed.batch.repoPath, claimed.batch.baseBranch, claimed.batch.expectedCommit)
      await this.log(operationId, 3, 'primitive', 'succeeded', message, { primitiveCode: 'promote_commit_to_base', result: { batchId: claimed.batch.batchId } })
      if (!this.hostRepoRoot) throw new Error('DEPLOY_REPO_HOST não configurado')
      const remote = await this.remote.start({ batchId: claimed.batch.batchId, expectedCommit: claimed.batch.expectedCommit, hostRepoRoot: this.hostRepoRoot, deployScript: this.script })
      await this.repository.markRemoteStarted(claimed.batch.batchId, remote.pid, remote.statusPath, message)
      await this.log(operationId, 4, 'primitive', 'succeeded', message, { primitiveCode: 'start_remote_blue_green', result: { batchId: claimed.batch.batchId, pid: remote.pid, statusPath: remote.statusPath } })
      await this.log(operationId, 5, 'completed', 'succeeded', message, { actionCode: 'A31_DISPATCH_DEPLOY_BATCH', result: { batchId: claimed.batch.batchId } })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.repository.completeBatch(claimed.batch.batchId, false, reason, message)
      await this.log(operationId, 4, 'failed', 'failed', message, { actionCode: 'A31_DISPATCH_DEPLOY_BATCH', reasonCode: 'dispatch_failed', result: { error: reason } }); throw error
    }
  }

  private async reconcile(message: QueueMessage): Promise<void> {
    const batchId = String(message.payload.batchId ?? ''); if (!batchId) throw new Error('Reconciliação sem batchId')
    const batch = (await this.repository.runningBatches()).find(item => item.batchId === batchId); if (!batch) return
    const operationId = randomUUID(); await this.log(operationId, 1, 'received', 'executed', message, { commandCode: 'C12_DEPLOY_RECONCILIATION_REQUESTED' })
    if (!await this.govern(operationId, message, 'A32_RECONCILE_DEPLOY_BATCH')) return
    const status = batch.remoteStatusPath ? await this.remote.status(batch.remoteStatusPath) : null
    const timedOut = batch.startedAt && Date.now() - new Date(batch.startedAt).getTime() > this.timeoutMs
    if (status === 'success' || status?.startsWith('failed:') || timedOut) {
      const success = status === 'success'; const reason = success ? null : status?.startsWith('failed:') ? `script blue-green retornou ${status}` : 'processo remoto não produziu resultado dentro do timeout'
      const taskIds = await this.repository.completeBatch(batchId, success, reason, message)
      await this.log(operationId, 3, success ? 'completed' : 'failed', success ? 'succeeded' : 'failed', message, { actionCode: 'A32_RECONCILE_DEPLOY_BATCH', primitiveCode: success ? 'complete_deploy_batch_atomic' : 'fail_deploy_batch_atomic', result: { batchId, taskIds, reason } })
    }
  }

  private async integrationContext(raw: Omit<DeployTaskContext, 'integrationPath' | 'integrationBranch' | 'integrationCommit'>): Promise<DeployTaskContext> {
    const interim = this.repository.withIntegration(raw, '')
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: interim.integrationPath, encoding: 'utf8' })
    const commit = stdout.trim(); if (!/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error('Commit da integração inválido')
    return { ...interim, repoPath: mapHostRepoPathToContainer(interim.repoPath) ?? interim.repoPath, integrationCommit: commit }
  }

  private async promote(repoPath: string, baseBranch: string, expectedCommit: string): Promise<void> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath, encoding: 'utf8' }); const repo = stdout.trim()
    if (await execFileAsync('git', ['merge-base', '--is-ancestor', expectedCommit, baseBranch], { cwd: repo }).then(() => true, () => false)) return
    const path = `${repo}/.motor-v3-deploy-${expectedCommit.slice(0, 12)}`
    await execFileAsync('git', ['worktree', 'add', '--detach', path, baseBranch], { cwd: repo })
    try { await execFileAsync('git', ['merge', '--ff-only', expectedCommit], { cwd: path }); await execFileAsync('git', ['push', 'origin', `HEAD:${baseBranch}`], { cwd: path }) }
    finally { await execFileAsync('git', ['worktree', 'remove', '--force', path], { cwd: repo }).catch(() => undefined) }
  }

  /** Catálogo decide a action; as invariantes adicionais continuam nas primitives. */
  private async govern(operationId: string, message: QueueMessage, expectedAction: string): Promise<boolean> {
    if (!this.commandPolicies) return true
    const governed = await this.commandPolicies.findByMessageType(message.type)
    const decision = new CommandPolicyResolver().decide(governed?.command, governed?.policies ?? [], { paused: false, terminal: false, blocked: false, subtaskCount: 0, analysisClaimed: false })
    if (decision.kind !== 'execute' || decision.policy.actionCode !== expectedAction) {
      await this.log(operationId, 2, 'rejected', 'rejected', message, { commandCode: decision.command?.code, policyCode: decision.kind === 'execute' ? decision.policy.code : undefined, reasonCode: decision.kind === 'reject' ? decision.reasonCode : 'unexpected_deploy_action' })
      return false
    }
    await this.log(operationId, 2, 'decision', 'executed', message, { commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version, actionCode: decision.policy.actionCode })
    return true
  }

  private async reject(operationId: string, message: QueueMessage, reasonCode: string): Promise<void> { await this.log(operationId, 99, 'rejected', 'rejected', message, { commandCode: 'C10_DEPLOY_REQUESTED', policyCode: 'P10_DEPLOY_IF_ELIGIBLE', actionCode: 'A30_ACCEPT_DEPLOY_REQUEST', reasonCode }) }
  private async log(operationId: string, sequence: number, phase: any, outcome: any, message: QueueMessage, extra: Record<string, unknown>): Promise<void> { await this.logger?.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...(extra as any) }) }
}
