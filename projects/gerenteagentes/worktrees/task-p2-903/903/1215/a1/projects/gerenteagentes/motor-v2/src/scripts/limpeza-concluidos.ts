#!/usr/bin/env node

/**
 * Limpeza histórica de concluídos.
 *
 * O padrão é prévia. A escrita só é habilitada por --apply, depois que todo o
 * lote foi selecionado e verificado pelo Git. Este script nunca faz deploy,
 * merge, checkout, push ou altera tarefas.status.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createDbConnection } from "../database/DrizzleDb.js"
import type { Db } from "../shared/types/infrastructure.js"
import { deriveTaskStatus, type DerivedTaskStatusFacts } from "../policies/DerivedTaskStatus.js"
import { CompletedDeploymentGitVerifier, type CompletedDeploymentGitCandidate, type CompletedDeploymentGitResult } from "../reconciliation/CompletedDeploymentGitVerifier.js"
import { CompletedDeploymentReconciler, type CompletedDeploymentReconciliationCandidate } from "../reconciliation/CompletedDeploymentReconciler.js"
import type { GitCommandRunner } from "../workspaces/GitWorkspaceManager.js"

const execFileAsync = promisify(execFile)

export type CleanupDecision = "alterada" | "ja_correta" | "mantida_por_conflito" | "inconclusiva" | "fora_do_escopo"

export interface CleanupReportItem {
  tarefaId: string
  externalId: string | null
  titulo: string
  projeto: string
  branch: string
  shaBase: string | null
  shaTarefa: string | null
  decisao: CleanupDecision
  motivo: string
}

export interface CleanupReport {
  modo: "previa" | "aplicacao"
  alteradas: CleanupReportItem[]
  jaCorretas: CleanupReportItem[]
  mantidasPorConflito: CleanupReportItem[]
  inconclusivas: CleanupReportItem[]
  foraDoEscopo: CleanupReportItem[]
}

interface SelectedTask extends CompletedDeploymentGitCandidate {
  tarefaId: string
  externalId: string | null
  titulo: string
  projeto: string
  tipo: string | null
  derivedStatus: string
  integrationConfirmed: boolean
  deploySucceeded: boolean
  deployFailed: boolean
  activeBlocker: boolean
}

class NodeGitRunner implements GitCommandRunner {
  async run(command: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const [file, ...args] = command
    if (!file) throw new Error("comando Git vazio")
    return execFileAsync(file, args, { cwd, timeout: 120_000 })
  }
}

function flag(row: Record<string, unknown>, key: string): boolean { return Number(row[key] ?? 0) === 1 }

function sortItems(items: CleanupReportItem[]): CleanupReportItem[] {
  return items.sort((a, b) => a.tarefaId.localeCompare(b.tarefaId, "pt-BR", { numeric: true }) || a.decisao.localeCompare(b.decisao))
}

function item(task: SelectedTask, decision: CleanupDecision, reason: string, git?: CompletedDeploymentGitResult): CleanupReportItem {
  return {
    tarefaId: task.tarefaId,
    externalId: task.externalId,
    titulo: task.titulo,
    projeto: task.projeto,
    branch: git?.evidence.taskBranch ?? `motor-v2/${task.externalId || task.tarefaId}/integracao`,
    shaBase: git?.evidence.baseSha ?? null,
    shaTarefa: git?.evidence.taskSha ?? null,
    decisao: decision,
    motivo: reason,
  }
}

/** Seleção factual: o status é calculado, nunca lido de tarefas.status. */
export async function selecionar(db: Db): Promise<SelectedTask[]> {
  const result = await db.query(
    "SELECT t.id, t.external_id, t.titulo, t.tipo, COALESCE(pc.slug, CAST(t.projeto_id AS CHAR), '-') AS projeto, " +
    "pmc.repo_path, COALESCE(NULLIF(pmc.branch_trabalho, ''), 'base-desenvolvimento') AS base_branch, " +
    "f.analysis_started_at, f.integration_confirmed_at, f.terminal_status, t.paused_at, t.resource_wait_key, " +
    "EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id=t.id AND b.resolved_at IS NULL) AS active_blocker, " +
    "EXISTS(SELECT 1 FROM tarefa_contextos_execucao cix WHERE cix.tarefa_id=t.id AND cix.estado='awaiting_human') AS awaiting_interaction, " +
    "(SELECT c.role FROM tarefa_chats c WHERE c.tarefa_id=t.id AND c.role IN ('analyst','user') ORDER BY c.id DESC LIMIT 1) AS last_clarification_role, " +
    "EXISTS(SELECT 1 FROM deploy_requests d WHERE d.tarefa_id=t.id AND d.status='succeeded') AS deploy_succeeded, " +
    "EXISTS(SELECT 1 FROM deploy_requests d WHERE d.tarefa_id=t.id AND d.status='failed') AS deploy_failed, " +
    "EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id=t.id) AS has_subtasks " +
    "FROM tarefas t LEFT JOIN projetos_captados pc ON pc.id=t.projeto_id " +
    "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id " +
    "LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id ORDER BY t.id",
  )
  const subtasks = await db.query("SELECT tarefa_id, status FROM subtarefas ORDER BY tarefa_id, id")
  const byTask = new Map<string, string[]>()
  for (const row of subtasks.rows) {
    const key = String(row.tarefa_id)
    const values = byTask.get(key) ?? []
    values.push(String(row.status))
    byTask.set(key, values)
  }
  return result.rows.map((row) => {
    const statuses = byTask.get(String(row.id)) ?? []
    const facts: DerivedTaskStatusFacts = {
      terminalStatus: row.terminal_status == null ? null : String(row.terminal_status),
      hasPendingClarification: row.last_clarification_role === "analyst",
      awaitingInteraction: flag(row, "awaiting_interaction"),
      hasActiveBlocker: flag(row, "active_blocker"),
      analysisInProgress: row.analysis_started_at != null,
      hasPersistedPlan: flag(row, "has_subtasks"),
      subtaskStatuses: statuses,
      deploySucceeded: flag(row, "deploy_succeeded"),
      deployFailed: flag(row, "deploy_failed"),
      integrationConfirmed: row.integration_confirmed_at != null,
      pausedAt: row.paused_at == null ? null : String(row.paused_at),
      resourceWaitKey: row.resource_wait_key == null ? null : String(row.resource_wait_key),
    }
    return {
      tarefaId: String(row.id), externalId: row.external_id == null ? null : String(row.external_id),
      titulo: String(row.titulo ?? ""), projeto: String(row.projeto ?? "-"), tipo: row.tipo == null ? null : String(row.tipo),
      repoPath: String(row.repo_path ?? ""), baseBranch: String(row.base_branch ?? "base-desenvolvimento"),
      derivedStatus: deriveTaskStatus(facts), integrationConfirmed: facts.integrationConfirmed,
      deploySucceeded: facts.deploySucceeded, deployFailed: facts.deployFailed, activeBlocker: facts.hasActiveBlocker,
    }
  })
}

export async function executar(db: Db, apply: boolean, runner: GitCommandRunner = new NodeGitRunner()): Promise<CleanupReport> {
  const tasks = await selecionar(db)
  const report: CleanupReport = { modo: apply ? "aplicacao" : "previa", alteradas: [], jaCorretas: [], mantidasPorConflito: [], inconclusivas: [], foraDoEscopo: [] }
  const candidates = tasks.filter((task) => task.tipo === "desenvolvimento" && task.derivedStatus === "completed" && !task.deploySucceeded)
  for (const task of tasks) {
    if (task.tipo !== "desenvolvimento") report.foraDoEscopo.push(item(task, "fora_do_escopo", `tipo/status derivado: ${task.tipo ?? "nulo"}/${task.derivedStatus}`))
    else if (task.deploySucceeded) report.jaCorretas.push(item(task, "ja_correta", "deploy histórico succeeded já registrado"))
    else if (task.derivedStatus !== "completed") report.foraDoEscopo.push(item(task, "fora_do_escopo", `tipo/status derivado: ${task.tipo ?? "nulo"}/${task.derivedStatus}`))
  }
  const gitResults = await new CompletedDeploymentGitVerifier(runner).verifyAll(candidates)
  const confirmed = new Map(gitResults.confirmed.map((result) => [result.tarefaId, result]))
  const reconcilable: CompletedDeploymentReconciliationCandidate[] = []
  for (const task of candidates) {
    const git = gitResults.results.find((result) => result.tarefaId === task.tarefaId)
    if (!git || git.classification === "inconclusive") { report.inconclusivas.push(item(task, "inconclusiva", git?.reason ?? "verificação Git ausente", git)); continue }
    if (task.activeBlocker || task.deployFailed) { report.mantidasPorConflito.push(item(task, "mantida_por_conflito", task.activeBlocker ? "bloqueio ativo" : "histórico de deploy failed", git)); continue }
    reconcilable.push({ tarefaId: task.tarefaId, externalId: task.externalId, tipo: task.tipo, derivedStatus: task.derivedStatus, integrationConfirmed: task.integrationConfirmed, gitConfirmed: confirmed.has(task.tarefaId), repoPath: task.repoPath })
  }
  if (apply && reconcilable.length > 0) {
    const reconciliation = await new CompletedDeploymentReconciler(db).reconcile(reconcilable)
    for (const result of reconciliation.items) {
      const task = tasks.find((candidate) => candidate.tarefaId === String(result.tarefaId))
      const git = task ? confirmed.get(task.tarefaId) : undefined
      if (!task) continue
      if (result.action === "inserted") report.alteradas.push(item(task, "alterada", result.reason, git))
      else if (result.action === "preserved_existing" && result.existingStatus === "succeeded") report.jaCorretas.push(item(task, "ja_correta", result.reason, git))
      else if (result.action === "preserved_existing") report.mantidasPorConflito.push(item(task, "mantida_por_conflito", `histórico existente ${result.existingStatus ?? "desconhecido"}; preservado`, git))
      else if (result.action === "skipped_conflict") report.mantidasPorConflito.push(item(task, "mantida_por_conflito", result.reason, git))
      else report.inconclusivas.push(item(task, "inconclusiva", result.reason, git))
    }
  } else {
    for (const candidate of reconcilable) {
      const task = tasks.find((entry) => entry.tarefaId === String(candidate.tarefaId))!
      report.alteradas.push(item(task, "alterada", "candidato confirmado; prévia sem escrita", confirmed.get(task.tarefaId)))
    }
  }
  for (const key of ["alteradas", "jaCorretas", "mantidasPorConflito", "inconclusivas", "foraDoEscopo"] as const) sortItems(report[key])
  return report
}

function parseApply(argv: string[]): boolean {
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("use apenas --apply ou --dry-run")
  return argv.includes("--apply")
}

if (process.argv[1]?.endsWith("limpeza-concluidos.js")) {
  const apply = parseApply(process.argv.slice(2))
  const { db, connection } = await createDbConnection()
  try { console.log(JSON.stringify(await executar(db, apply), null, 2)) } finally { await connection.end() }
}
