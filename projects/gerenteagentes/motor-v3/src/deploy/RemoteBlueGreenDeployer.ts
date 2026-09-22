import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RemoteDeploymentStart { batchId: string; expectedCommit: string; hostRepoRoot: string; deployScript: string }
export interface RemoteDeploymentHandle { pid: string; statusPath: string; logPath: string }

/** Adaptador de infraestrutura: SSH e quoting nunca vazam para o domínio. */
export class RemoteBlueGreenDeployer {
  constructor(
    private readonly sshTarget = process.env.MOTOR_DEPLOY_SSH_TARGET,
    private readonly sshIdentity = process.env.MOTOR_DEPLOY_SSH_IDENTITY || '/root/.ssh/id_ed25519',
    private readonly timeoutMs = Number(process.env.MOTOR_DEPLOY_SSH_TIMEOUT_MS || 15_000),
  ) {}

  async assertReady(): Promise<void> { await this.ssh('true') }

  async start(input: RemoteDeploymentStart): Promise<RemoteDeploymentHandle> {
    if (!/^[a-f0-9]{7,64}$/i.test(input.expectedCommit)) throw new Error('Commit esperado de deploy inválido')
    const safeBatch = input.batchId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const statusPath = `/tmp/biblioteca-global-${safeBatch}.status`
    const logPath = `/tmp/biblioteca-global-${safeBatch}.log`
    const script = `${input.hostRepoRoot.replace(/\/$/, '')}/${input.deployScript.replace(/^\//, '')}`
    const run = `EXPECTED_DEPLOY_COMMIT=${quote(input.expectedCommit)} bash ${quote(script)} ${quote(input.hostRepoRoot)} ${quote(input.expectedCommit)} ${quote(safeBatch)}`
    const wrapped = `(${run}; code=$?; if [ $code -eq 0 ]; then status=success; else status=failed:$code; fi; printf '%s' "$status" > ${quote(statusPath)}; exit $code)`
    const { stdout } = await this.ssh(`nohup bash -lc ${quote(wrapped)} > ${quote(logPath)} 2>&1 < /dev/null & echo $!`)
    const pid = stdout.trim()
    if (!/^\d+$/.test(pid)) throw new Error(`SSH não confirmou PID do deploy destacado: ${pid.slice(0, 200)}`)
    return { pid, statusPath, logPath }
  }

  async status(statusPath: string): Promise<string | null> {
    if (!/^\/tmp\/biblioteca-global-[A-Za-z0-9_-]+\.status$/.test(statusPath)) throw new Error('Caminho de status remoto inválido')
    const { stdout } = await this.ssh(`if [ -f ${quote(statusPath)} ]; then cat ${quote(statusPath)}; fi`)
    return stdout.trim() || null
  }

  private async ssh(command: string): Promise<{ stdout: string; stderr: string }> {
    if (!this.sshTarget) throw new Error('MOTOR_DEPLOY_SSH_TARGET não configurado')
    return execFileAsync('ssh', ['-i', this.sshIdentity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/root/.ssh/known_hosts', '-o', 'ConnectTimeout=10', this.sshTarget, command], { encoding: 'utf8', timeout: this.timeoutMs })
  }
}
function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }
