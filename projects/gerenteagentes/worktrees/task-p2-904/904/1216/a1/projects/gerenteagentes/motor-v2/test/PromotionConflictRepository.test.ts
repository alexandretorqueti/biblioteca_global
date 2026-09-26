import { describe, expect, it, vi } from "vitest"
import { PromotionConflictRepository } from "../src/promotion-conflicts/PromotionConflictRepository.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

const empty = { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult

describe("PromotionConflictRepository", () => {
  it("reconstrói candidato de bloqueio estruturado após reinício", async () => {
    const db = { query: vi.fn().mockResolvedValue({ ...empty, rows: [{
      block_id: 9, tarefa_id: 793, subtarefa_id: null, external_id: "task-p2-793",
      block_command: "motor-v2:promotion-conflict:base-desenvolvimento:motor-v2%2Ftask-p2-793%2Fintegracao:abc",
      block_excerpt: "Conflito no merge da branch da tarefa para a base",
      repo_path: "/repo", base_branch: "base-desenvolvimento", agent_id: "gerenteagentes",
    }] }), transaction: vi.fn() } as unknown as Db
    const result = await new PromotionConflictRepository(db).findPendingCandidates()
    expect(result[0]).toMatchObject({ blockId: 9, taskBranch: "motor-v2/task-p2-793/integracao" })
  })

  it("claim usa INSERT IGNORE e não duplica fingerprint", async () => {
    const query = vi.fn().mockResolvedValueOnce({ ...empty, affectedRows: 1 })
    const repository = new PromotionConflictRepository({ query, transaction: vi.fn() } as unknown as Db)
    const claimed = await repository.claim(
      { taskId: "task-1", agentId: "agent", repoPath: "/repo", baseBranch: "base", taskBranch: "task" },
      { taskId: "task-1", baseBranch: "base", taskBranch: "task", baseCommit: "a".repeat(40), taskCommit: "b".repeat(40), mergeBase: "c".repeat(40), fingerprint: "d".repeat(64), conflictFiles: [] },
    )
    expect(claimed).toBe(true)
    expect(String(query.mock.calls[0]?.[0])).toContain("INSERT IGNORE")
  })
})

