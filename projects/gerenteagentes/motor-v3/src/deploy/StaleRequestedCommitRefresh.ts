import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { mapHostRepoPathToContainer } from '../execution/GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)

/**
 * Runner Git mínimo (args, cwd) → resultado. Injetável para testes; a
 * implementação padrão degrada para `{ ok: false }` em qualquer falha
 * (branch inexistente, repo inacessível, não-ancestralidade), preservando o
 * comportamento histórico de manter o `requested_commit` gravado.
 */
export interface GitRunner {
  (args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }>
}

export const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    return { ok: true, stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

export interface StaleRequestedCommitRefreshInput {
  databaseTaskId: number
  taskId: string
  repoPath: string | null
  staleCommit: string | null
  git?: GitRunner
}

export interface StaleRequestedCommitRefreshResult {
  refreshed: boolean
  /** HEAD atual da branch de integração quando resolvido; null caso contrário. */
  headCommit: string | null
}

/**
 * Fast-forward do `requested_commit` obsoleto para o HEAD atual da branch de
 * integração quando ele é descendente do commit gravado — o padrão do Monitor
 * é commitar a correção diretamente na branch de integração após a falha do
 * gate pre_deploy (família dos incidentes task-p2-979/1011/1047/1056).
 *
 * Sem o refresh, o dispatch recompõe o lote com o SHA antigo e o gate reprova
 * de novo pelo mesmo motivo, em loop. Compartilhado entre TaskUnblockedConsumer
 * (reativação failed→pending no TASK_UNBLOCKED) e ExternalResolutionHandler
 * (reativação via external-resolution com requestDeploy=true) — o incidente
 * task-p2-1056 (2026-11-01) mostrou que só o primeiro caminho refrescava: o
 * handler reativava o request preserving o commit obsoleto e o consumer, ao
 * encontrá-lo já `pending`, saía sem refrescar.
 *
 * Branch divergente (rebase/força) ou qualquer falha de Git mantêm o commit
 * gravado (comportamento histórico): conflitos de composição continuam
 * tratados pelo fluxo `deploy_member_conflict`. O UPDATE mira pedidos
 * `pending` na MESMA transação do chamador (a reativação failed→pending já
 * ocorreu), então o dispatch seguinte enxerga o commit novo.
 */
export async function refreshStaleRequestedCommit(
  connection: PoolConnection,
  input: StaleRequestedCommitRefreshInput,
): Promise<StaleRequestedCommitRefreshResult> {
  const { databaseTaskId, taskId, repoPath, staleCommit } = input
  const git = input.git ?? defaultGitRunner
  if (!repoPath || !staleCommit || !/^[a-f0-9]{7,64}$/i.test(staleCommit)) {
    return { refreshed: false, headCommit: null }
  }
  const safeTask = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '-')
  const branch = `motor-v3-work/integration-${safeTask}`
  const mappedRepoPath = mapHostRepoPathToContainer(repoPath)
  const cwd = existsSync(repoPath)
    ? repoPath
    : mappedRepoPath && existsSync(mappedRepoPath)
      ? mappedRepoPath
      : repoPath
  const head = await git(['rev-parse', '--verify', `${branch}^{commit}`], cwd)
  const headCommit = head.stdout.trim()
  if (!head.ok || !/^[a-f0-9]{7,64}$/i.test(headCommit) || headCommit === staleCommit) {
    return { refreshed: false, headCommit: null }
  }
  const ancestor = await git(['merge-base', '--is-ancestor', staleCommit, headCommit], cwd)
  if (!ancestor.ok) return { refreshed: false, headCommit: null }
  await connection.query<ResultSetHeader>(
    `UPDATE deploy_requests SET requested_commit=?, updated_at=NOW()
      WHERE tarefa_id=? AND status='pending' AND requested_commit=?`,
    [headCommit, databaseTaskId, staleCommit],
  )
  return { refreshed: true, headCommit }
}
