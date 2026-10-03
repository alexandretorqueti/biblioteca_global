import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RemoteDeploymentStart { batchId: string; expectedCommit: string; hostRepoRoot: string; deployScript: string }
export interface RemoteDeploymentHandle { pid: string; statusPath: string; logPath: string }
export type RemoteDeploymentStatus =
  | { state: 'active'; status: null; diagnostic: string | null }
  | { state: 'success'; status: 'success'; diagnostic: string | null }
  | { state: 'failed'; status: `failed:${number}`; diagnostic: string | null }
  | { state: 'absent' | 'invalid'; status: string | null; diagnostic: string }

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
    const run = `MOTOR_DEPLOY_STATUS_FILE=${quote(statusPath)} MOTOR_DEPLOY_LOG_FILE=${quote(logPath)} EXPECTED_DEPLOY_COMMIT=${quote(input.expectedCommit)} bash ${quote(script)} ${quote(input.hostRepoRoot)} ${quote(input.expectedCommit)} ${quote(safeBatch)}`
    const wrapped = `(${run}; code=$?; if [ $code -eq 0 ]; then status=success; else status=failed:$code; fi; printf '%s' "$status" > ${quote(statusPath)}; exit $code)`
    const { stdout } = await this.ssh(`nohup bash -lc ${quote(wrapped)} > ${quote(logPath)} 2>&1 < /dev/null & echo $!`)
    const pid = stdout.trim()
    if (!/^\d+$/.test(pid)) throw new Error(`SSH não confirmou PID do deploy destacado: ${pid.slice(0, 200)}`)
    return { pid, statusPath, logPath }
  }

  async status(statusPath: string, pid?: string | null): Promise<RemoteDeploymentStatus> {
    if (!/^\/tmp\/biblioteca-global-[A-Za-z0-9_-]+\.status$/.test(statusPath)) throw new Error('Caminho de status remoto inválido')
    if (pid != null && !/^\d+$/.test(pid)) throw new Error('PID remoto inválido')
    const logPath = statusPath.replace(/\.status$/, '.log')
    const pidCheck = pid ? `if kill -0 ${quote(pid)} 2>/dev/null; then printf 'active'; else printf 'absent'; fi` : "printf 'absent'"
    const { stdout } = await this.ssh(`printf 'process='; ${pidCheck}; printf '\\nstatus='; if [ -f ${quote(statusPath)} ]; then cat ${quote(statusPath)}; fi; printf '\\nlog='; if [ -f ${quote(logPath)} ]; then tail -n 40 ${quote(logPath)}; fi`)
    const process = stdout.match(/(?:^|\n)process=([^\n]*)/)?.[1] ?? 'absent'
    const rawStatus = stdout.match(/(?:^|\n)status=([^\n]*)/)?.[1]?.trim() || null
    const rawLog = stdout.match(/(?:^|\n)log=([\s\S]*)/)?.[1] ?? ''
    const diagnostic = limitDiagnostic(rawLog)
    if (rawStatus === 'success') return { state: 'success', status: 'success', diagnostic }
    if (/^failed:[1-9]\d*$/.test(rawStatus ?? '')) return { state: 'failed', status: rawStatus as `failed:${number}`, diagnostic }
    if (process === 'active') return { state: 'active', status: null, diagnostic: diagnostic || (rawStatus ? `status ainda não terminal: ${rawStatus}` : null) }
    if (!rawStatus) return { state: 'absent', status: null, diagnostic: diagnostic || 'processo remoto ausente sem status terminal' }
    return { state: 'invalid', status: rawStatus, diagnostic: diagnostic || `status remoto inválido: ${rawStatus}` }
  }

  private async ssh(command: string): Promise<{ stdout: string; stderr: string }> {
    if (!this.sshTarget) throw new Error('MOTOR_DEPLOY_SSH_TARGET não configurado')
    return execFileAsync('ssh', ['-i', this.sshIdentity, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/root/.ssh/known_hosts', '-o', 'ConnectTimeout=10', this.sshTarget, command], { encoding: 'utf8', timeout: this.timeoutMs })
  }
}
function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }

function limitDiagnostic(value: string): string | null {
  const normalized = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  if (!normalized) return null
  return normalized.slice(-4000)
}
