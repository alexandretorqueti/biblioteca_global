#!/usr/bin/env node
/**
 * Motor v2 - Script de recuperação (runbook: docs/runbook-recuperacao.md)
 *
 * Operações idempotentes para recuperar estados presos após falhas de
 * integração/publish, bloqueios ambientais ou worktrees órfãos.
 *
 * Uso (após `npm run build`):
 *   node dist/scripts/recover.js status
 *   node dist/scripts/recover.js unblock --tarefa <id> [--dry-run]
 *   node dist/scripts/recover.js integrate --subtarefa <id> [--dry-run]
 *   node dist/scripts/recover.js mark-integrated --subtarefa <id> [--dry-run]
 *
 * A conexão usa as variáveis MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD
 * (mesmas do motor). Nenhuma operação toca o repositório além do que o
 * GitWorkspaceManager.integrate já faz em produção.
 */

import { createDbConnection } from "../database/DrizzleDb.js"
import { GitWorkspaceManager } from "../workspaces/GitWorkspaceManager.js"
import type { Db } from "../shared/types/infrastructure.js"

interface CliOptions {
  tarefaId?: string
  subtaskId?: number
  dryRun: boolean
}

function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const [command] = argv
  const options: CliOptions = { dryRun: false }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--tarefa") options.tarefaId = argv[++i]
    else if (arg === "--subtarefa") options.subtaskId = Number(argv[++i])
  }
  if (!command) throw new Error("comando ausente: status | unblock | integrate | mark-integrated")
  return { command, options }
}

async function printStatus(db: Db): Promise<void> {
  const blockedTasks = await db.query(
    "SELECT t.id, t.external_id, t.titulo, t.status, t.updated_at FROM projeto_640.tarefas t WHERE t.status = 'blocked' ORDER BY t.id",
  )
  const blockedSubtasks = await db.query(
    "SELECT s.id, s.seq, s.titulo, s.tarefa_id, s.status, s.workspace_status, s.updated_at FROM projeto_640.subtarefas s WHERE s.status = 'blocked' ORDER BY s.id",
  )
  const integrationFailed = await db.query(
    "SELECT s.id, s.seq, s.tarefa_id, s.workspace_branch, s.workspace_commit_sha, s.resultado FROM projeto_640.subtarefas s WHERE s.workspace_status = 'integration_failed' ORDER BY s.id",
  )
  const bloqueios = await db.query(
    "SELECT b.tarefa_id, b.subtarefa_id, b.block_reason, LEFT(b.block_excerpt, 120) AS excerpt, b.blocked_at FROM projeto_640.bloqueios b ORDER BY b.blocked_at DESC LIMIT 15",
  )
  const leases = await db.query(
    "SELECT resource_key, execution_id, owner_id, expires_at FROM projeto_640.execution_resources ORDER BY expires_at",
  )

  console.log("== Tarefas bloqueadas ==")
  if (blockedTasks.rows.length === 0) console.log("  (nenhuma)")
  for (const row of blockedTasks.rows) {
    console.log(`  #${row.id} (${row.external_id ?? "-"}) ${row.titulo} [${row.status}] atualizada em ${row.updated_at}`)
  }

  console.log("== Subtarefas bloqueadas ==")
  if (blockedSubtasks.rows.length === 0) console.log("  (nenhuma)")
  for (const row of blockedSubtasks.rows) {
    console.log(`  #${row.id} seq=${row.seq} tarefa=${row.tarefa_id} ${row.titulo} [workspace=${row.workspace_status ?? "-"}]`)
  }

  console.log("== Integrações pendentes (workspace_status=integration_failed) ==")
  if (integrationFailed.rows.length === 0) console.log("  (nenhuma)")
  for (const row of integrationFailed.rows) {
    console.log(`  subtarefa #${row.id} seq=${row.seq} tarefa=${row.tarefa_id} branch=${row.workspace_branch ?? "-"} commit=${row.workspace_commit_sha ?? "-"}`)
    if (row.resultado) console.log(`    motivo: ${String(row.resultado).substring(0, 200)}`)
  }

  console.log("== Últimos bloqueios registrados ==")
  if (bloqueios.rows.length === 0) console.log("  (nenhum)")
  for (const row of bloqueios.rows) {
    console.log(`  ${row.blocked_at} tarefa=${row.tarefa_id} subtarefa=${row.subtarefa_id ?? "-"} [${row.block_reason}] ${row.excerpt}`)
  }

  console.log("== Leases ativos ==")
  if (leases.rows.length === 0) console.log("  (nenhum)")
  for (const row of leases.rows) {
    console.log(`  ${row.resource_key} owner=${row.owner_id} exec=${row.execution_id} expira=${row.expires_at}`)
  }
}

async function findTaskId(db: Db, externalId: string): Promise<number | null> {
  const isNumeric = /^\d+$/.test(externalId)
  const { rows } = await db.query(
    isNumeric
      ? "SELECT id FROM projeto_640.tarefas WHERE external_id = ? OR id = ? LIMIT 1"
      : "SELECT id FROM projeto_640.tarefas WHERE external_id = ? LIMIT 1",
    isNumeric ? [externalId, externalId] : [externalId],
  )
  return rows.length > 0 ? Number(rows[0]!.id) : null
}

async function unblockTask(db: Db, options: CliOptions): Promise<void> {
  if (!options.tarefaId) throw new Error("--tarefa <id> é obrigatório")
  const taskId = await findTaskId(db, options.tarefaId)
  if (taskId === null) throw new Error("tarefa não encontrada: " + options.tarefaId)

  const task = await db.query("SELECT status FROM projeto_640.tarefas WHERE id = ?", [taskId])
  const taskStatus = String(task.rows[0]?.status ?? "")
  const subtasks = await db.query(
    "SELECT status, COUNT(*) AS total FROM projeto_640.subtarefas WHERE tarefa_id = ? GROUP BY status",
    [taskId],
  )
  const hasPlan = subtasks.rows.length > 0

  const plan: string[] = []
  if (taskStatus === "blocked") {
    plan.push(`tarefa #${taskId}: blocked -> ${hasPlan ? "ready" : "planned"}`)
  } else {
    console.log(`Tarefa #${taskId} não está bloqueada (status=${taskStatus}); nada a fazer no nível da tarefa.`)
  }
  const blockedCount = subtasks.rows.find((row) => row.status === "blocked")
  if (blockedCount) {
    plan.push(`subtarefas bloqueadas da tarefa #${taskId}: blocked -> pending (${blockedCount.total})`)
  }

  if (plan.length === 0) {
    console.log("Nenhuma ação necessária.")
    return
  }
  for (const step of plan) console.log((options.dryRun ? "[dry-run] " : "") + step)
  if (options.dryRun) return

  if (taskStatus === "blocked") {
    await db.query(
      "UPDATE projeto_640.tarefas SET status = ?, updated_at = NOW() WHERE id = ? AND status = 'blocked'",
      [hasPlan ? "ready" : "planned", taskId],
    )
  }
  await db.query(
    "UPDATE projeto_640.subtarefas SET status = 'pending', updated_at = NOW() WHERE tarefa_id = ? AND status = 'blocked'",
    [taskId],
  )
  console.log("Desbloqueio aplicado. O próximo pump do motor retoma o trabalho.")
}

interface IntegrationContext {
  subtaskId: number
  tarefaId: number
  workspaceStatus: string | null
  workspaceBranch: string | null
  workspaceCommitSha: string | null
  subtaskStatus: string
  repoPath: string
  branchTrabalho: string
}

async function loadIntegrationContext(db: Db, subtaskId: number): Promise<IntegrationContext> {
  const { rows } = await db.query(
    "SELECT s.id, s.tarefa_id, s.status AS subtask_status, s.workspace_status, s.workspace_branch, s.workspace_commit_sha, " +
    "pmc.repo_path, pmc.branch_trabalho " +
    "FROM projeto_640.subtarefas s " +
    "INNER JOIN projeto_640.tarefas t ON t.id = s.tarefa_id " +
    "LEFT JOIN projeto_640.projetos_captados pc ON pc.id = t.projeto_id " +
    "LEFT JOIN projeto_640.projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
    "WHERE s.id = ?",
    [subtaskId],
  )
  const row = rows[0]
  if (!row) throw new Error("subtarefa não encontrada: " + subtaskId)
  const repoPath = String(row.repo_path ?? "")
  const branchTrabalho = String(row.branch_trabalho ?? "")
  if (!repoPath || !branchTrabalho) throw new Error("subtarefa sem repo_path/branch_trabalho no projeto_motor_config")
  return {
    subtaskId,
    tarefaId: Number(row.tarefa_id),
    workspaceStatus: row.workspace_status ? String(row.workspace_status) : null,
    workspaceBranch: row.workspace_branch ? String(row.workspace_branch) : null,
    workspaceCommitSha: row.workspace_commit_sha ? String(row.workspace_commit_sha) : null,
    subtaskStatus: String(row.subtask_status),
    repoPath,
    branchTrabalho,
  }
}

async function integrateSubtask(db: Db, options: CliOptions): Promise<void> {
  if (!options.subtaskId) throw new Error("--subtarefa <id> é obrigatório")
  const context = await loadIntegrationContext(db, options.subtaskId)

  if (context.workspaceStatus === "integrated") {
    console.log(`Subtarefa #${context.subtaskId} já está integrada; nada a fazer.`)
    return
  }
  if (context.workspaceStatus !== "integration_failed" && context.workspaceStatus !== "approved") {
    throw new Error(`workspace_status=${context.workspaceStatus ?? "nulo"} não é recuperável por integração (esperado integration_failed ou approved)`)
  }
  if (!context.workspaceBranch || !context.workspaceCommitSha) {
    throw new Error("subtarefa sem workspace_branch/workspace_commit_sha; use mark-integrated após merge manual")
  }

  console.log(
    (options.dryRun ? "[dry-run] " : "") +
    `integrar ${context.workspaceBranch} (${context.workspaceCommitSha}) em ${context.branchTrabalho} @ ${context.repoPath}`,
  )
  if (options.dryRun) return

  const workspaceManager = new GitWorkspaceManager({ root: process.env.MOTOR_WORKSPACE_ROOT ?? "/tmp/motor-v2-workspaces" })
  const { mergeCommit } = await workspaceManager.integrate({
    repoPath: context.repoPath,
    baseBranch: context.branchTrabalho,
    workBranch: context.workspaceBranch,
    expectedCommit: context.workspaceCommitSha,
  })
  await db.query(
    "UPDATE projeto_640.subtarefas SET workspace_status = 'integrated', resultado = CONCAT(COALESCE(resultado, ''), ?) WHERE id = ?",
    [`\nIntegrado via recover em ${new Date().toISOString()} (merge ${mergeCommit})`, context.subtaskId],
  )
  await db.query(
    "UPDATE projeto_640.tarefas SET status = 'ready', updated_at = NOW() WHERE id = ? AND status = 'blocked'",
    [context.tarefaId],
  )
  console.log(`Integração concluída: merge ${mergeCommit}. Tarefa #${context.tarefaId} devolvida para ready (se estava bloqueada).`)
}

async function markIntegrated(db: Db, options: CliOptions): Promise<void> {
  if (!options.subtaskId) throw new Error("--subtarefa <id> é obrigatório")
  const context = await loadIntegrationContext(db, options.subtaskId)

  if (context.workspaceStatus === "integrated") {
    console.log(`Subtarefa #${context.subtaskId} já está integrada; nada a fazer.`)
    return
  }
  const step = `subtarefa #${context.subtaskId}: workspace_status ${context.workspaceStatus ?? "nulo"} -> integrated (merge manual presumido) + tarefa #${context.tarefaId} bloqueada -> ready`
  console.log((options.dryRun ? "[dry-run] " : "") + step)
  if (options.dryRun) return

  await db.query(
    "UPDATE projeto_640.subtarefas SET workspace_status = 'integrated', resultado = CONCAT(COALESCE(resultado, ''), ?) WHERE id = ?",
    [`\nMarcado como integrado manualmente via recover em ${new Date().toISOString()}`, context.subtaskId],
  )
  await db.query(
    "UPDATE projeto_640.tarefas SET status = 'ready', updated_at = NOW() WHERE id = ? AND status = 'blocked'",
    [context.tarefaId],
  )
  console.log("Marcado como integrado. Confira o merge no repositório antes de retomar a tarefa.")
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2))
  const { db, connection } = await createDbConnection()
  try {
    switch (command) {
      case "status":
        await printStatus(db)
        break
      case "unblock":
        await unblockTask(db, options)
        break
      case "integrate":
        await integrateSubtask(db, options)
        break
      case "mark-integrated":
        await markIntegrated(db, options)
        break
      default:
        throw new Error("comando desconhecido: " + command)
    }
  } finally {
    await connection.end()
  }
}

main().catch((error) => {
  console.error("ERRO:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
