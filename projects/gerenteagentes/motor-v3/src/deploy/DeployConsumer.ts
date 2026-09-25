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
    if (message.type === 'DEPLOY_BATCH_RESULT_RECEIVED') return this.receiveResult(message)
    if (message.type === 'TEST_RUN_COMPLETED') return this.afterGate(message)
    if (message.type === 'TASK_EXECUTION_COMPLETED') { await this.repository.enqueuePendingDispatches(); return }
  }

  async requestReconciliation(): Promise<number> { return this.repository.enqueueReconciliationForRunning() }
  async recoverPendingWork(): Promise<number> {
    const recovered = await this.repository.enqueueCompletedRecoveries()
    const dispatches = await this.repository.enqueuePendingDispatches()
    return recovered + dispatches
  }

  private async accept(message: QueueMessage): Promise<void> {
    const operationId = randomUUID()
    await this.log(operationId, 1, 'received', 'executed', message, { commandCode: 'C10_DEPLOY_REQUESTED' })
    if (!await this.govern(operationId, message, 'A30_ACCEPT_DEPLOY_REQUEST')) return
    let raw: Omit<DeployTaskContext, 'integrationPath' | 'integrationBranch' | 'integrationCommit'> | null
    try {
      raw = await this.repository.getEligibleTask(message.taskId)
    } catch (error) {
      return this.reject(operationId, message, error instanceof Error ? error.message : 'deploy_not_eligible')
    }
    if (!raw) return this.reject(operationId, message, 'task_not_found')
    try {
      const context = await this.integrationContext(raw)
      const accepted = await this.repository.acceptRequest(context, message)
      const jobId = await this.gate.enqueue({ projectId: context.projectId, taskDatabaseId: context.databaseTaskId, phase: 'pre_deploy', commitSha: context.integrationCommit, baseCommitSha: context.integrationCommit, branchName: context.integrationBranch, workspacePath: context.integrationPath, buildCommand: context.buildCommand, testCommand: context.testCommand }, message)
      await this.log(operationId, 3, 'primitive', 'succeeded', message, { primitiveCode: 'upsert_deploy_request', result: { requestId: accepted.requestId, gateJobId: jobId } })
      await this.log(operationId, 4, 'completed', 'succeeded', message, { actionCode: 'A30_ACCEPT_DEPLOY_REQUEST', result: { requestId: accepted.requestId, gateJobId: jobId } })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.block(operationId, message, 'deploy_preparation_failed', detail)
    }
  }

  private async dispatch(message: QueueMessage): Promise<void> {
    const operationId = randomUUID(); await this.log(operationId, 1, 'received', 'executed', message, { commandCode: 'C11_DEPLOY_BATCH_DISPATCH_REQUESTED' })
    if (!await this.govern(operationId, message, 'A31_DISPATCH_DEPLOY_BATCH')) return
    const claimed = await this.repository.claimBatch(message)
    // Seq 3: o govern() já gravou a decisão no seq 2; colisão aqui violaria
    // (operation_id, sequence) e transformaria o skip benigno em retry infinito.
    if (!claimed) return this.log(operationId, 3, 'completed', 'skipped', message, { reasonCode: 'motor_busy_or_no_compatible_pending_batch' })
    try {
      const composed = await this.composeBatch(claimed.batch.repoPath, claimed.batch.baseBranch, claimed.batch.batchId, claimed.members.map(member => member.requestedCommit))
      try {
        const primary = claimed.members[0]!
        if (claimed.members.some(member => member.buildCommand !== primary.buildCommand || member.testCommand !== primary.testCommand)) {
          throw new Error('Lote reúne projetos com comandos de gate incompatíveis')
        }
        const gateJobId = await this.gate.enqueue({ projectId: primary.projectId, taskDatabaseId: primary.databaseTaskId, phase: 'pre_deploy', commitSha: composed.commit, baseCommitSha: claimed.batch.baseBranch, branchName: claimed.batch.baseBranch, workspacePath: composed.path, buildCommand: primary.buildCommand, testCommand: primary.testCommand }, message)
        await this.repository.setBatchPrepared(claimed.batch.batchId, composed.commit, composed.path, gateJobId)
        await this.log(operationId, 3, 'completed', 'succeeded', message, { actionCode: 'A31_DISPATCH_DEPLOY_BATCH', result: { batchId: claimed.batch.batchId, gateJobId, expectedCommit: composed.commit, memberCount: claimed.members.length } })
      } catch (error) {
        await this.removeComposedWorktree(claimed.batch.repoPath, composed.path)
        throw error
      }
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

  private async receiveResult(message: QueueMessage): Promise<void> {
    const batchId = String(message.payload.batchId ?? '')
    const success = message.payload.status === 'success'
    if (!batchId || (message.payload.status !== 'success' && message.payload.status !== 'failed')) throw new Error('Resultado de deploy inválido')
    const taskIds = await this.repository.completeBatch(batchId, success, success ? null : 'script blue-green informou falha', message)
    const operationId = randomUUID()
    await this.log(operationId, 1, success ? 'completed' : 'failed', success ? 'succeeded' : 'failed', message, { actionCode: 'A33_RECEIVE_DEPLOY_RESULT', primitiveCode: success ? 'complete_deploy_batch_atomic' : 'fail_deploy_batch_atomic', result: { batchId, taskIds } })
  }

  private async afterGate(message: QueueMessage): Promise<void> {
    if (message.payload.phase !== 'pre_deploy') return
    const testRunId = Number(message.payload.testRunId)
    if (!Number.isInteger(testRunId) || testRunId <= 0) throw new Error('TEST_RUN_COMPLETED pre_deploy sem testRunId')
    const result = await this.repository.continueAfterPreDeployGate(message.taskId, testRunId, message)
    const operationId = randomUUID()
    await this.log(operationId, 1, result.accepted ? 'completed' : 'failed', result.accepted ? 'succeeded' : 'failed', message, { actionCode: 'A30_ACCEPT_DEPLOY_REQUEST', primitiveCode: 'run_pre_deploy_gate', reasonCode: result.reason, result: { testRunId } })
    const jobId = Number(message.payload.jobId)
    if (!Number.isInteger(jobId) || jobId <= 0) return
    const batch = await this.repository.findPendingBatchByGateJob(jobId)
    if (!batch) return
    try {
      if (message.payload.status !== 'passed') throw new Error('Gate pre_deploy do commit composto falhou')
      await this.startPreparedBatch(batch, message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.repository.completeBatch(batch.batchId, false, reason, message)
      if (batch.workspacePath) await this.removeComposedWorktree(batch.repoPath, batch.workspacePath)
      throw error
    }
  }

  private async startPreparedBatch(batch: import('./DeployRepository.js').DeployBatch, message: QueueMessage): Promise<void> {
    if (!batch.workspacePath) throw new Error(`Lote ${batch.batchId} sem worktree composto`)
    await this.remote.assertReady()
    await this.promote(batch.repoPath, batch.baseBranch, batch.expectedCommit)
    if (!this.hostRepoRoot) throw new Error('DEPLOY_REPO_HOST não configurado')
    const remote = await this.remote.start({ batchId: batch.batchId, expectedCommit: batch.expectedCommit, hostRepoRoot: this.hostRepoRoot, deployScript: this.script })
    await this.repository.markRemoteStarted(batch.batchId, remote.pid, remote.statusPath, message)
    await this.removeComposedWorktree(batch.repoPath, batch.workspacePath)
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

  /** Compõe patches das integrações pendentes sobre a branch-base em worktree exclusivo do lote. */
  private async composeBatch(repoPath: string, baseBranch: string, batchId: string, commits: string[]): Promise<{ path: string; commit: string }> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath, encoding: 'utf8' })
    const repo = stdout.trim(); const path = `${repo}/.motor-v3-deploy-${batchId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    await execFileAsync('git', ['worktree', 'add', '--detach', path, baseBranch], { cwd: repo })
    try {
      // Para cada commit de integração, listar TODOS os commits entre baseBranch e o commit,
      // não apenas o HEAD. Isso garante que todas as subtarefas sejam incluídas no deploy.
      const allCommitsToCherryPick: string[] = []
      for (const commit of [...new Set(commits)]) {
        if (!/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error(`Commit de integração inválido: ${commit}`)
        const contained = await execFileAsync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: path }).then(() => true, () => false)
        if (contained) continue
        // Listar todos os commits entre baseBranch e commit (exclusivo baseBranch, inclusivo commit)
        // Ordem reversa (mais antigo primeiro) para cherry-pick na ordem correta
        const { stdout: logOutput } = await execFileAsync('git', ['rev-list', '--reverse', `${baseBranch}..${commit}`], { cwd: path })
        const commitRange = logOutput.trim().split('\n').filter(Boolean)
        for (const c of commitRange) {
          if (!allCommitsToCherryPick.includes(c)) {
            allCommitsToCherryPick.push(c)
          }
        }
      }
      // Fazer cherry-pick de todos os commits na ordem
      for (const c of allCommitsToCherryPick) {
        try {
          await execFileAsync('git', ['cherry-pick', c], { cwd: path })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('empty')) {
            await execFileAsync('git', ['cherry-pick', '--skip'], { cwd: path })
          } else {
            throw error
          }
        }
      }
      await execFileAsync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: path })
      await execFileAsync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: `${path}/projects/gerenteagentes/motor-v3` })
      const { stdout: composed } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' })
      return { path, commit: composed.trim() }
    } catch (error) {
      await this.removeComposedWorktree(repo, path)
      throw error
    }
  }

  private async removeComposedWorktree(repoPath: string, path: string): Promise<void> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: repoPath, encoding: 'utf8' }).catch(() => ({ stdout: repoPath }))
    await execFileAsync('git', ['worktree', 'remove', '--force', path], { cwd: stdout.trim() }).catch(() => undefined)
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
  private async block(operationId: string, message: QueueMessage, reasonCode: string, detail: string): Promise<void> { await this.repository.blockTask(message.taskId, reasonCode, detail, message); await this.log(operationId, 99, 'failed', 'failed', message, { actionCode: 'A30_ACCEPT_DEPLOY_REQUEST', reasonCode, result: { error: detail } }) }
  private async log(operationId: string, sequence: number, phase: any, outcome: any, message: QueueMessage, extra: Record<string, unknown>): Promise<void> { await this.logger?.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...(extra as any) }) }
}
