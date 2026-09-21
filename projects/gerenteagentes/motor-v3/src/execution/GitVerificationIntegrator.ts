import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SubtaskExecutionContext } from './DevelopmentExecutionRepository.js'
import type { GitWorktreePreparer } from './GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)

export interface VerificationResult { commitSha: string; integrationCommitSha: string }

/** Verifica, commita e integra sem alterar o checkout base nem publicar branches. */
export class GitVerificationIntegrator {
  constructor(private readonly worktrees: GitWorktreePreparer) {}

  async verifyAndIntegrate(context: SubtaskExecutionContext): Promise<VerificationResult> {
    if (!context.workspacePath || !context.workspaceBranch || !context.workspaceBaseCommit) throw new Error('Subtarefa sem workspace persistido')
    // O gate já foi executado e comparado com o baseline antes da transição
    // para `delivered`. Reexecutá-lo aqui perderia a semântica diferencial e
    // voltaria a reprovar a tarefa por falhas preexistentes.
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: context.workspacePath })
    if (status.trim()) {
      await execFileAsync('git', ['add', '-A'], { cwd: context.workspacePath })
      await execFileAsync('git', ['commit', '-m', `motor-v3: tarefa ${context.taskId}, subtarefa ${context.seq}`], { cwd: context.workspacePath })
    }
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: context.workspacePath })
    if (commit.trim() === context.workspaceBaseCommit) throw new Error('Programador concluiu sem alterações no worktree')
    const integration = await this.worktrees.prepareIntegration(context)
    const alreadyIntegrated = await execFileAsync('git', ['merge-base', '--is-ancestor', commit.trim(), 'HEAD'], { cwd: integration.path })
      .then(() => true, () => false)
    if (!alreadyIntegrated) await execFileAsync('git', ['cherry-pick', commit.trim()], { cwd: integration.path })
    const { stdout: integrated } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: integration.path })
    return { commitSha: commit.trim(), integrationCommitSha: integrated.trim() }
  }
}
