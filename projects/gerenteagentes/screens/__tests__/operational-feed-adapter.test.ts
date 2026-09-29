import { describe, expect, it } from "vitest"
import { feedItemFromEnvelope, mergeFeedItem, normalizeFeedSnapshot } from "../operational-feed-adapter"
import type { TaskEventEnvelope } from "@biblioteca-global/shared"

const envelope = (overrides: Partial<TaskEventEnvelope> = {}): TaskEventEnvelope => ({
  eventId: "evt-1", sequence: 1, occurredAt: "2026-09-29T10:00:00.000Z", source: "motor",
  projectId: 1, taskId: 7, type: "task.chat.message", payload: { id: 22, texto: "Olá", role: "assistant" }, ...overrides,
})

describe("operational-feed-adapter", () => {
  it("adapta mensagem realtime e deduplica atualizações mais recentes", () => {
    const first = feedItemFromEnvelope(envelope())!
    const newer = feedItemFromEnvelope(envelope({ occurredAt: "2026-09-29T10:01:00.000Z", payload: { id: 22, texto: "Atualizada", role: "assistant", estado: "delivered" } }))!
    expect(first.id).toBe("message:22")
    expect(mergeFeedItem([first], newer)).toEqual([expect.objectContaining({ text: "Atualizada", state: "delivered" })])
    expect(mergeFeedItem([newer], first)).toEqual([newer])
  })

  it("mantém somente snapshot válido, ordenado e limitado", () => {
    const items = normalizeFeedSnapshot({ items: [
      { ...feedItemFromEnvelope(envelope({ eventId: "old", occurredAt: "2026-09-29T09:00:00.000Z" }))!, id: "old" },
      { ...feedItemFromEnvelope(envelope({ eventId: "new", occurredAt: "2026-09-29T11:00:00.000Z" }))!, id: "new" },
      null as never,
    ] })
    expect(items.map(item => item.id)).toEqual(["new", "old"])
  })
})
