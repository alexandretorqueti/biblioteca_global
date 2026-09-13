import { describe, expect, it } from "vitest"
import { ManagedPromptResolver } from "../src/prompts/ManagedPromptResolver.js"

function fakeDb(text: string | null) {
  const inserts: unknown[][] = []
  const updates: unknown[][] = []
  return {
    inserts,
    updates,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT p.id")) return { rows: [{ prompt_id: 7, version_id: 8, texto: text, contract_version_id: null, instrucoes: null, schema_json: null, exemplo_json: null }] }
      if (sql.startsWith("INSERT INTO prompts_execucoes")) {
        inserts.push(params ?? [])
        return { insertId: 42 }
      }
      if (sql.startsWith("UPDATE prompts_execucoes")) {
        updates.push(params ?? [])
        return { affectedRows: 1 }
      }
      throw new Error(`SQL inesperado: ${sql}`)
    },
  }
}

describe("ManagedPromptResolver guarantees", () => {
  it("anexa garantia ausente, respeita limite e persiste fallback_usado", async () => {
    const db = fakeDb("Título: **TITULOTAREFA**")
    const result = await new ManagedPromptResolver(db).resolveDetailed({
      key: "dev.primeira_rodada_tarefa",
      values: { "**TITULOTAREFA**": "Tarefa" },
      fallback: "fallback",
      guarantees: [{ marker: "**DESCRICAOTAREFA**", value: "descrição longa", label: "Descrição da tarefa", limit: 5 }],
    })

    expect(result.text).toContain("Descrição da tarefa:\ndescr")
    expect(result.fallbackUsado).toBe(true)
    expect(db.inserts[0]?.[6]).toBe(1)
  })

  it("não anexa garantia quando o marcador está publicado", async () => {
    const db = fakeDb("Descrição: **DESCRICAOTAREFA**")
    const result = await new ManagedPromptResolver(db).resolveDetailed({
      key: "dev.primeira_rodada_tarefa",
      values: { "**DESCRICAOTAREFA**": "descrição" },
      fallback: "fallback",
      guarantees: [{ marker: "**DESCRICAOTAREFA**", value: "descrição", label: "Descrição da tarefa" }],
    })

    expect(result.text).toBe("Descrição: descrição")
    expect(result.fallbackUsado).toBe(false)
    expect(db.inserts[0]?.[6]).toBe(0)
  })

  it("registra nota explícita quando a garantia está vazia", async () => {
    const db = fakeDb("Título")
    const result = await new ManagedPromptResolver(db).resolveDetailed({
      key: "dev.primeira_rodada_tarefa",
      values: {},
      fallback: "fallback",
      guarantees: [{ marker: "**DESCRICAOTAREFA**", value: "", label: "Descrição da tarefa" }],
    })

    expect(result.text).not.toContain("Descrição da tarefa:")
    expect(result.fallbackUsado).toBe(false)
    expect(result.guaranteeNotes[0]).toContain("conteúdo não foi enviado")
  })

  it("usa fallback quando a versão ativa está sem texto", async () => {
    const db = fakeDb(null)
    const result = await new ManagedPromptResolver(db).resolveDetailed({
      key: "dev.primeira_rodada_tarefa",
      values: {},
      fallback: "Fallback embarcado",
    })

    expect(result.text).toBe("Fallback embarcado")
    expect(result.fallbackUsado).toBe(true)
    expect(db.inserts[0]?.[6]).toBe(1)
  })

  it("grava composição como JSON válido em round-trip", async () => {
    const db = fakeDb("Título")
    const resolver = new ManagedPromptResolver(db)
    const composition = { fallbackUsado: true, guaranteeNotes: ["nota"] }
    await resolver.recordFinalComposition(42, "final", composition)

    const stored = db.updates[0]?.[1]
    expect(typeof stored).toBe("string")
    expect(JSON.parse(String(stored))).toEqual(composition)
  })
})
