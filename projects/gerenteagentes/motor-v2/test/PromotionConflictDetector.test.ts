import { describe, expect, it } from "vitest"
import { identifyPromotionConflict } from "../src/promotion-conflicts/PromotionConflictDetector.js"

describe("identifyPromotionConflict", () => {
  it("identifica bloqueio estruturado de promoção", () => {
    const result = identifyPromotionConflict({
      tarefa_id: 793, external_id: "task-p2-793", subtarefa_id: null,
      block_command: "motor-v2:promotion-conflict:abc", block_excerpt: "",
      task_branch: "motor-v2/task-p2-793/integracao", base_branch: "base-desenvolvimento",
      repo_path: "/repo", agent_id: "gerenteagentes",
    })
    expect(result).toMatchObject({ taskId: "task-p2-793", taskBranch: "motor-v2/task-p2-793/integracao" })
  })

  it("reconhece bloqueio legado e extrai branches e arquivos", () => {
    const result = identifyPromotionConflict({
      tarefa_id: 793, external_id: "task-p2-793", subtarefa_id: null,
      block_command: "motor-v2:old",
      block_excerpt: "Conflito no merge da branch da tarefa para a base (base-desenvolvimento) — resolução humana necessária. Arquivos em conflito: a.ts, b.json. Branch preservada: motor-v2/task-p2-793/integracao",
      repo_path: "/repo", agent_id: "gerenteagentes",
    })
    expect(result?.reportedFiles).toEqual(["a.ts", "b.json"])
    expect(result?.baseBranch).toBe("base-desenvolvimento")
  })

  it("ignora conflito de subtarefa e erro Git genérico", () => {
    expect(identifyPromotionConflict({ subtarefa_id: 1, block_excerpt: "Conflito no merge da branch da tarefa para a base" })).toBeNull()
    expect(identifyPromotionConflict({ subtarefa_id: null, block_excerpt: "fatal: not a git repository" })).toBeNull()
  })
})

