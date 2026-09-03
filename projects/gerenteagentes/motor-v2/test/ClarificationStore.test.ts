import { describe, expect, it, vi } from "vitest"
import {
  formatClarificationMessage,
  formatHistoryForPrompt,
  persistTaskClarification,
  persistTaskClarificationAnswer,
  fetchTaskClarificationHistory,
} from "../src/planning/ClarificationStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function mockDb(responses: QueryResult[]): Db {
  const db: Db = {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

describe("formatClarificationMessage", () => {
  it("monta mensagem única com entendimento e perguntas numeradas", () => {
    const text = formatClarificationMessage({ summary: "Entendi que é um chat", questions: ["MySQL ou Postgres?", "Qual o prazo?"] })
    expect(text).toContain("Entendimento atual: Entendi que é um chat")
    expect(text).toContain("1) MySQL ou Postgres?")
    expect(text).toContain("2) Qual o prazo?")
  })

  it("omite o entendimento quando o resumo é vazio", () => {
    const text = formatClarificationMessage({ summary: "  ", questions: ["p?"] })
    expect(text).not.toContain("Entendimento atual")
    expect(text).toContain("1) p?")
  })
})

describe("formatHistoryForPrompt", () => {
  it("marca perguntas e respostas para reinjeção no prompt", () => {
    const text = formatHistoryForPrompt([
      { role: "analyst", texto: "1) A ou B?", createdAt: "" },
      { role: "user", texto: "1: A", createdAt: "" },
    ])
    expect(text).toContain("[ANALISTA] 1) A ou B?")
    expect(text).toContain("[RESPOSTA] 1: A")
  })

  it("retorna vazio sem histórico", () => {
    expect(formatHistoryForPrompt([])).toBe("")
  })
})

describe("persistTaskClarification", () => {
  it("resolve a tarefa por external_id e grava mensagem analyst", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 1 },
    ])
    await persistTaskClarification(db, "task-9", { summary: "s", questions: ["p?"] })
    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[0]![0])).toContain("FROM tarefas")
    const [insertSql, params] = calls[1]!
    expect(String(insertSql)).toContain("INSERT INTO tarefa_chats")
    expect(params).toEqual([42, "analyst", expect.stringContaining("1) p?")])
  })
})

describe("persistTaskClarificationAnswer", () => {
  it("grava a resposta como role user na mesma tabela do chat", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 2 },
    ])
    await persistTaskClarificationAnswer(db, "42", "1: MySQL")
    const [insertSql, params] = vi.mocked(db.query).mock.calls[1]!
    expect(String(insertSql)).toContain("INSERT INTO tarefa_chats")
    expect(params).toEqual([42, "user", "1: MySQL"])
  })
})

describe("fetchTaskClarificationHistory", () => {
  it("retorna somente mensagens analyst/user em ordem", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      {
        rows: [
          { role: "analyst", texto: "1) A?", created_at: "2026-09-01 12:00:00" },
          { role: "user", texto: "1: B", created_at: "2026-09-01 13:00:00" },
        ],
        affectedRows: 0,
        insertId: 0,
      },
    ])
    const history = await fetchTaskClarificationHistory(db, "task-9")
    expect(history).toHaveLength(2)
    expect(history[0]!.role).toBe("analyst")
    const [selectSql, params] = vi.mocked(db.query).mock.calls[1]!
    expect(String(selectSql)).toContain("role IN (?, ?)")
    expect(params).toEqual([42, "analyst", "user"])
  })
})
