import { describe, expect, it, vi } from "vitest"
import { ManagedPromptResolver } from "../src/prompts/ManagedPromptResolver.js"

describe("ManagedPromptResolver", () => {
  it("persiste composição JSON estruturada, sem converter partes em [object Object]", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], affectedRows: 1, insertId: 0 })
    await new ManagedPromptResolver({ query } as never).recordFinalComposition(7, "prompt final", [
      { source: "table", label: "Prompt", text: "conteúdo" },
    ])

    const composition = JSON.parse(String(query.mock.calls[0]?.[1]?.[1]))
    expect(composition).toEqual([{ source: "table", label: "Prompt", text: "conteúdo" }])
    expect(String(query.mock.calls[0]?.[1]?.[1])).not.toContain("[object Object]")
  })
})
