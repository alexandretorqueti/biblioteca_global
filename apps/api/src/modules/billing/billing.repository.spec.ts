// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { DrizzleBillingRepository } from "./billing.repository"

const event = { id: 1, dedupeKey: "payment.updated:pay-1" }

function repositoryWithInsertResult(insertResult: { insertId?: number; affectedRows?: number }) {
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onDuplicateKeyUpdate: vi.fn().mockResolvedValue([insertResult]),
    }),
  })
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([event]) }),
    }),
  })
  return { repository: new DrizzleBillingRepository({ insert, select } as never), insert, select }
}

describe("DrizzleBillingRepository webhook dedupe", () => {
  it.each([
    [{ insertId: 10, affectedRows: 1 }, false],
    [{ insertId: 0, affectedRows: 1 }, true],
    [{ insertId: 0, affectedRows: 0 }, true],
  ])("detecta duplicata com insertId/affectedRows: %j", async (insertResult, duplicate) => {
    const { repository } = repositoryWithInsertResult(insertResult)
    await expect(repository.inserirWebhook({
      dedupeKey: "payment.updated:pay-1", tipo: "payment.updated", payload: {},
    })).resolves.toEqual({ event, duplicate })
  })
})
