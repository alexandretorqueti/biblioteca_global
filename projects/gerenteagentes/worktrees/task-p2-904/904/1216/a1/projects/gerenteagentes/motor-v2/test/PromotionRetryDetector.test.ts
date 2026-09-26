import { describe, expect, it } from "vitest"
import { identifyDirtyPromotionRetry } from "../src/promotion-retries/PromotionRetryDetector.js"

describe("identifyDirtyPromotionRetry", () => {
  it("identifica bloqueio estruturado e preserva tentativa/branches", () => {
    const result = identifyDirtyPromotionRetry({
      id: 9, tarefa_id: 810, external_id: "task-p2-810", subtarefa_id: null,
      block_command: "motor-v2:promotion-repo-dirty:base-desenvolvimento:motor-v2%2Ftask-p2-810%2Fintegracao:2",
      repo_path: "/repo", project_slug: "gerenteagentes",
    })
    expect(result).toMatchObject({ taskId: "task-p2-810", blockId: 9, attempt: 2, taskBranch: "motor-v2/task-p2-810/integracao" })
  })

  it("aceita o bloqueio legado da 810 para permitir recuperação após deploy", () => {
    const result = identifyDirtyPromotionRetry({
      id: 817, tarefa_id: 810, external_id: "task-p2-810", subtarefa_id: null,
      block_command: "motor-v2:legacy", base_branch: "base-desenvolvimento", repo_path: "/repo",
      block_excerpt: "Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção: x. Branch preservada: motor-v2/task-p2-810/integracao",
    })
    expect(result).toMatchObject({ attempt: 0, baseBranch: "base-desenvolvimento", taskBranch: "motor-v2/task-p2-810/integracao" })
  })

  it("não captura conflito Git nem bloqueio de subtarefa", () => {
    expect(identifyDirtyPromotionRetry({ subtarefa_id: null, block_excerpt: "Conflito no merge" })).toBeNull()
    expect(identifyDirtyPromotionRetry({ subtarefa_id: 2, block_excerpt: "Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção: x" })).toBeNull()
  })
})
