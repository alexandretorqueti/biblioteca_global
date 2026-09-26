import { describe, expect, it, vi } from "vitest"
import { PromotionRetryRepository } from "../src/promotion-retries/PromotionRetryRepository.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

const empty = { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult

/**
 * Reconhecer a 3ª variante legada de bloqueio sujo não pode acordar o fluxo de
 * retry de promoção em tarefa que já está na base — isso reexecutaria a
 * promoção de algo já integrado/deployado.
 */
describe("PromotionRetryRepository", () => {
  async function candidateSql(): Promise<string> {
    const query = vi.fn().mockResolvedValue({ ...empty })
    await new PromotionRetryRepository({ query, transaction: vi.fn() } as unknown as Db).findEligibleCandidates()
    return String(query.mock.calls[0]?.[0])
  }

  it("só considera tarefa não integrada, não terminal e sem deploy concluído", async () => {
    const sql = await candidateSql()
    expect(sql).toContain("task_runtime_facts")
    expect(sql).toContain("f.integration_confirmed_at IS NOT NULL")
    expect(sql).toContain("f.terminal_status IS NOT NULL")
    expect(sql).toContain("deploy_requests")
    expect(sql).toContain("d.status = 'succeeded'")
    expect(sql).toContain("NOT EXISTS")
  })

  it("mantém o recorte de repo sujo (todas as gerações) e o backoff", async () => {
    const sql = await candidateSql()
    expect(sql).toContain("motor-v2:promotion-repo-dirty:")
    expect(sql).toContain("motor-v2:repositório principal não está limpo:")
    expect(sql).toContain("%repositório principal não está limpo%")
    expect(sql).toContain("DATE_SUB(NOW(), INTERVAL 5 MINUTE)")
    expect(sql).toContain("b.subtarefa_id IS NULL")
  })

  it("não toca em bloqueio já resolvido", async () => {
    expect(await candidateSql()).toContain("b.resolved_at IS NULL")
  })
})
