import { describe, expect, it } from "vitest"
import { taskIdentifierLookup } from "../src/database/TaskIdentifierLookup.js"

describe("taskIdentifierLookup", () => {
  it("compara o ID interno apenas para entradas numéricas", () => {
    expect(taskIdentifierLookup("123", "t")).toEqual({
      sql: "(t.external_id = ? OR t.id = ?)",
      params: ["123", 123],
    })
  })

  it("não força identificadores textuais para o tipo numérico", () => {
    expect(taskIdentifierLookup("task-p2-819", "t")).toEqual({
      sql: "t.external_id = ?",
      params: ["task-p2-819"],
    })
  })
})
