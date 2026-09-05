/**
 * P1 (Alexandre 2026-09-05): fluxo da branch de integração por tarefa no
 * TaskCoordinator.
 * - Conflito subtarefa → branch da tarefa: merge cancelado, subtarefa volta a
 *   pending para o AGENTE resolver (escala só se repetir).
 * - Gate de integração vermelho: revert merge + rework; 2ª falha → bloqueio.
 * - Conflito na promoção tarefa → base: SEMPRE humano — tarefa bloqueada,
 *   merge cancelado, artefatos preservados (sem purge).
 */
import { describe, expect, it, vi } from "vitest"
import type { Db, QueryResult, TaskRepository } from "../src/shared/types/infrastructure.js"
import { ResourceLeaseService } from "../src/resources/ResourceLeaseService.js"
import { TaskCoordinator } from "../src/coordinator/TaskCoordinator.js"
import { WorkerLauncher } from "../src/workers/WorkerLauncher.js"

interface DispatchRule {
  match: string
  rows: Record<string, unknown>[]
}

function createDispatchDb(rules: DispatchRule[]): Db {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      const text = String(sql)
      for (const rule of rules) {
        if (text.includes(rule.match)) return { rows: rule.rows, affectedRows: 1, insertId: 0 } satisfies QueryResult
      }
      return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
    }),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(null as never)),
  }
}

function createRepository(status = "running"): TaskRepository {
  return {
    saveTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({
      id: "task-p", chatId: "", agentId: "agent", title: "Tarefa P1", description: "",
      repoPath: "/repo", buildCommand: "npm run build", unitTestCommand: "npm run test",
      status, maxRework: 1, hardTimeoutMs: 1000, projectSlug: null,
    }),
  } as unknown as TaskRepository
}

interface FakeWorkspaceOptions {
  integration?: unknown
  promotion?: unknown
}

function createWorkspaceManager(options: FakeWorkspaceOptions = {}) {
  return {
    integrate: vi.fn(),
    integrateIntoTaskBranch: vi.fn().mockResolvedValue(options.integration ?? { kind: "merged", mergeCommit: "c".repeat(40), preMergeHead: "a".repeat(40) }),
    revertTaskBranchMerge: vi.fn().mockResolvedValue(undefined),
    promoteTaskBranch: vi.fn().mockResolvedValue(options.promotion ?? { kind: "promoted", mergeCommit: "d".repeat(40) }),
    publishBranch: vi.fn().mockResolvedValue(undefined),
    purgeTaskArtifacts: vi.fn().mockResolvedValue({ worktreesRemoved: 0, branchesRemoved: 0 }),
    ensureTaskIntegration: vi.fn(),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn(),
    changedPaths: vi.fn().mockResolvedValue([]),
  }
}

interface InternalWorker {
  taskId: string; executionId: string; resourceKey: null; fencingToken: number
  startedAt: Date; phase: "execute"; subtaskId: number; repoPath: string
  baseBranch: string; workspace: { path: string; branch: string; baseCommit: string }
  taskWorkspace: { path: string; projectPath: string; branch: string; baseCommit: string }
  rootBaseBranch: string; buildCommand?: string; testCommand?: string
}

function seedWorker(coordinator: TaskCoordinator, executionId: string): InternalWorker {
  const worker: InternalWorker = {
    taskId: "task-p", executionId, resourceKey: null, fencingToken: 0,
    startedAt: new Date(), phase: "execute", subtaskId: 55, repoPath: "/repo",
    baseBranch: "motor-v2/task-p/integracao",
    workspace: { path: "/tmp/ws-sub", branch: "motor-v2/task-p/55/a1", baseCommit: "a".repeat(40) },
    taskWorkspace: { path: "/tmp/ws-task", projectPath: "/tmp/ws-task", branch: "motor-v2/task-p/integracao", baseCommit: "a".repeat(40) },
    rootBaseBranch: "base-desenvolvimento",
  }
  const internal = coordinator as unknown as { activeWorkers: Map<string, InternalWorker> }
  internal.activeWorkers.set(executionId, worker)
  return worker
}

function createCoordinator(db: Db, repository: TaskRepository, workspaceManager: unknown): TaskCoordinator {
  return new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 }, new WorkerLauncher(), workspaceManager as never)
}

describe("conflito subtarefa → branch da tarefa", () => {
  it("merge cancelado, subtarefa re-enfileirada para o agente resolver, sem bloqueio", async () => {
    const db = createDispatchDb([
      { match: "event_type = 'integration_conflict'", rows: [{ total: 0 }] },
      { match: "SELECT deliver_count FROM subtarefas", rows: [{ deliver_count: 2 }] },
    ])
    const repository = createRepository()
    const wm = createWorkspaceManager({
      integration: { kind: "conflict", conflictFiles: ["src/a.ts"], reason: "Automatic merge failed" },
    })
    const coordinator = createCoordinator(db, repository, wm)
    seedWorker(coordinator, "exec-conflict")

    await coordinator.onTaskCompleted("exec-conflict", { gitCommitSha: "e".repeat(40) } as never)

    const calls = vi.mocked(db.query).mock.calls.map(([sql, params]) => ({ sql: String(sql), params }))
    // Subtarefa volta a pending com o diagnóstico do conflito.
    const requeue = calls.find((call) => call.sql.includes("status = 'pending'") && call.sql.includes("integration_conflict"))
    expect(requeue).toBeDefined()
    expect(String(requeue?.params?.[0])).toContain("src/a.ts")
    // Evento no histórico de entregas (carry-over da próxima tentativa).
    const event = calls.find((call) => call.sql.includes("INSERT INTO subtarefas_entregas"))
    expect(event?.params).toContain("integration_conflict")
    // Nada de bloqueio na primeira ocorrência.
    expect(calls.some((call) => call.sql.includes("INSERT INTO bloqueios"))).toBe(false)
    // Tarefa segue viva (subtasks_pending → ready), não bloqueada.
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }))
  })

  it("conflito repetido escala para intervenção humana (bloqueio)", async () => {
    const db = createDispatchDb([
      { match: "event_type = 'integration_conflict'", rows: [{ total: 1 }] },
      { match: "SELECT deliver_count FROM subtarefas", rows: [{ deliver_count: 3 }] },
    ])
    const repository = createRepository()
    const wm = createWorkspaceManager({
      integration: { kind: "conflict", conflictFiles: ["src/a.ts"], reason: "Automatic merge failed" },
    })
    const coordinator = createCoordinator(db, repository, wm)
    seedWorker(coordinator, "exec-conflict-2")

    await coordinator.onTaskCompleted("exec-conflict-2", { gitCommitSha: "e".repeat(40) } as never)

    const calls = vi.mocked(db.query).mock.calls.map(([sql, params]) => ({ sql: String(sql), params }))
    const bloqueio = calls.find((call) => call.sql.includes("INSERT INTO bloqueios"))
    expect(bloqueio).toBeDefined()
    expect(bloqueio?.params).toContain("systemic_failure")
    expect(calls.some((call) => call.sql.includes("status = 'blocked'") && call.sql.includes("integration_failed"))).toBe(true)
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked" }))
  })
})

describe("gate de integração na branch da tarefa", () => {
  it("vermelho → revert do merge + subtarefa re-enfileirada com diagnóstico", async () => {
    const db = createDispatchDb([
      { match: "event_type = 'integration_gate_failed'", rows: [{ total: 1 }] },
      { match: "SELECT deliver_count FROM subtarefas", rows: [{ deliver_count: 2 }] },
    ])
    const repository = createRepository()
    const wm = createWorkspaceManager()
    const coordinator = createCoordinator(db, repository, wm)
    const worker = seedWorker(coordinator, "exec-gate")

    const internal = coordinator as unknown as {
      handleTaskIntegrationGateFailure(worker: InternalWorker, executionId: string, preMergeHead: string, output: string): Promise<void>
    }
    await internal.handleTaskIntegrationGateFailure(worker, "exec-gate", "a".repeat(40), "Comando falhou na branch da tarefa (npm run test):\nAssertionError: expected 3 to be 4")

    expect(wm.revertTaskBranchMerge).toHaveBeenCalledWith("/tmp/ws-task", "a".repeat(40))
    const calls = vi.mocked(db.query).mock.calls.map(([sql, params]) => ({ sql: String(sql), params }))
    const requeue = calls.find((call) => call.sql.includes("status = 'pending'") && call.sql.includes("integration_reverted"))
    expect(requeue).toBeDefined()
    expect(String(requeue?.params?.[0])).toContain("AssertionError")
    expect(calls.some((call) => call.sql.includes("INSERT INTO bloqueios"))).toBe(false)
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }))
  })

  it("segunda falha de integração → bloqueio para intervenção humana", async () => {
    const db = createDispatchDb([
      { match: "event_type = 'integration_gate_failed'", rows: [{ total: 2 }] },
      { match: "SELECT deliver_count FROM subtarefas", rows: [{ deliver_count: 3 }] },
    ])
    const repository = createRepository()
    const wm = createWorkspaceManager()
    const coordinator = createCoordinator(db, repository, wm)
    const worker = seedWorker(coordinator, "exec-gate-2")

    const internal = coordinator as unknown as {
      handleTaskIntegrationGateFailure(worker: InternalWorker, executionId: string, preMergeHead: string, output: string): Promise<void>
    }
    await internal.handleTaskIntegrationGateFailure(worker, "exec-gate-2", "a".repeat(40), "AssertionError: expected 3 to be 4")

    expect(wm.revertTaskBranchMerge).toHaveBeenCalled()
    const calls = vi.mocked(db.query).mock.calls.map(([sql, params]) => ({ sql: String(sql), params }))
    expect(calls.some((call) => call.sql.includes("INSERT INTO bloqueios"))).toBe(true)
    expect(calls.some((call) => call.sql.includes("status = 'blocked'"))).toBe(true)
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked" }))
  })
})

describe("promoção da branch da tarefa para a base", () => {
  it("conflito com a base → tarefa bloqueada para resolução humana, merge cancelado, sem purge", async () => {
    const db = createDispatchDb([
      { match: "SELECT COUNT(*) as pending FROM subtarefas", rows: [{ pending: 0 }] },
      { match: "SELECT id, seq, workspace_commit_sha, status FROM subtarefas", rows: [{ id: 55, seq: 1, workspace_commit_sha: "abc1234", status: "verified" }] },
    ])
    const repository = createRepository()
    const wm = createWorkspaceManager({
      promotion: { kind: "conflict", conflictFiles: ["src/conflito.ts"], reason: "CONFLICT (content)" },
    })
    const coordinator = createCoordinator(db, repository, wm)
    seedWorker(coordinator, "exec-promo")

    // Entrega sem commit (ex.: gate pulado) — vai direto para o bloco de conclusão.
    await coordinator.onTaskCompleted("exec-promo", {} as never)

    expect(wm.promoteTaskBranch).toHaveBeenCalledWith({
      repoPath: "/repo",
      baseBranch: "base-desenvolvimento",
      taskBranch: "motor-v2/task-p/integracao",
    })
    const calls = vi.mocked(db.query).mock.calls.map(([sql, params]) => ({ sql: String(sql), params }))
    const bloqueio = calls.find((call) => call.sql.includes("INSERT INTO bloqueios"))
    expect(bloqueio).toBeDefined()
    expect(bloqueio?.params).toContain("blocked_environment")
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      status: "blocked",
      errorMessage: expect.stringContaining("resolução humana necessária"),
    }))
    // Artefatos preservados para o humano resolver: nada de purge, nada de execução concluída.
    expect(wm.purgeTaskArtifacts).not.toHaveBeenCalled()
    expect(repository.saveTask).not.toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }))
  })
})
