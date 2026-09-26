import { describe, expect, it, vi } from "vitest"
import { PromotionGateRecoveryOrchestrator } from "../src/promotion-gate/PromotionGateRecoveryOrchestrator.js"
import type { PromotionGateReport } from "../src/promotion-gate/PromotionGateVerifier.js"

const candidateRow = { id: 793, external_id: "task-p2-793", repo_path: "/repo", base_branch: "base-desenvolvimento" }

/** Fatos que derivam para `blocked` (subtarefas aprovadas + bloqueio ativo). */
const blockedFacts = {
  id: 793, paused_at: null, resource_wait_key: null, analysis_started_at: null,
  integration_confirmed_at: null, terminal_status: null, has_active_blocker: 1,
  last_clarification_role: null, deploy_succeeded: 0, deploy_failed: 0,
}

function makeDb(options: { rows?: Record<string, unknown>[]; facts?: Record<string, unknown>; acquired?: number }) {
  const seen: string[] = []
  const query = async (sql: string) => {
    seen.push(sql)
    if (sql.includes("GET_LOCK")) return { rows: [{ acquired: options.acquired ?? 1 }] }
    if (sql.includes("has_active_blocker")) return { rows: [options.facts ?? blockedFacts] }
    if (sql.includes("SELECT s.status FROM subtarefas")) return { rows: [{ status: "verified" }] }
    if (sql.includes("pmc.repo_path")) return { rows: options.rows ?? [] }
    return { rows: [] as Record<string, unknown>[] }
  }
  return { db: { query: vi.fn(query) } as never, seen }
}

function makePort() {
  return { recoverPromotionGate: vi.fn().mockResolvedValue(undefined), releaseStalePromotionBlocker: vi.fn().mockResolvedValue(undefined) }
}

const redReport: PromotionGateReport = { ok: false, issues: [{ kind: "migration_journal", fingerprint: "fp", message: "migration não registrada", evidence: "0029.sql" }] }

describe("PromotionGateRecoveryOrchestrator", () => {
  it("pesca a pendência bloqueada e cria corretiva quando o gate reprova", async () => {
    const { db } = makeDb({ rows: [candidateRow] })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await subject.reconcile()

    expect(port.recoverPromotionGate).toHaveBeenCalledWith(
      { taskId: "task-p2-793", repoPath: "/repo", baseBranch: "base-desenvolvimento", taskBranch: "motor-v2/task-p2-793/integracao" },
      redReport,
    )
  })

  it("não referencia a coluna inexistente tarefas.status (guardrail de schema)", async () => {
    const { db, seen } = makeDb({ rows: [candidateRow] })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await subject.reconcile()

    expect(seen.join("\n")).not.toMatch(/t\.status|tarefas\.status/)
  })

  it("ignora tarefa cujo estado derivado não é blocked (já integrada/deployada)", async () => {
    const { db } = makeDb({ rows: [candidateRow], facts: { ...blockedFacts, integration_confirmed_at: "2026-09-10T19:31:28Z", deploy_succeeded: 1 } })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await subject.reconcile()

    expect(port.recoverPromotionGate).not.toHaveBeenCalled()
  })

  it("não cria corretiva quando o gate está verde", async () => {
    const { db } = makeDb({ rows: [candidateRow] })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => ({ ok: true, issues: [] }))

    await subject.reconcile()

    expect(port.recoverPromotionGate).not.toHaveBeenCalled()
  })

  it("não processa quando outra instância detém o lock global", async () => {
    const { db } = makeDb({ rows: [candidateRow], acquired: 0 })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await subject.reconcile()

    expect(port.recoverPromotionGate).not.toHaveBeenCalled()
  })

  it("não falha quando não há candidato", async () => {
    const { db } = makeDb({ rows: [] })
    const port = makePort()
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await expect(subject.reconcile()).resolves.toBeUndefined()
    expect(port.recoverPromotionGate).not.toHaveBeenCalled()
  })

  it("libera corretiva do gate presa atrás de bloqueio de promoção obsoleto", async () => {
    const { db } = makeDb({ rows: [] })
    const port = makePort()
    ;(db as never as { query: (sql: string) => Promise<{ rows: unknown[] }> }).query = vi.fn(async (sql: string) => {
      if (sql.includes("GET_LOCK")) return { rows: [{ acquired: 1 }] }
      if (sql.includes("promotion-gate:%")) return { rows: [{ id: 793, external_id: "task-p2-793" }] }
      return { rows: [] }
    })
    const subject = new PromotionGateRecoveryOrchestrator(db, port as never, () => redReport)

    await subject.reconcile()

    expect(port.releaseStalePromotionBlocker).toHaveBeenCalledWith("task-p2-793")
    expect(port.recoverPromotionGate).not.toHaveBeenCalled()
  })
})
