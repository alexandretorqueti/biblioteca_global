import { describe, expect, it } from "vitest"
import { parseAnalystReply } from "../src/planning/AnalystReply.js"

describe("parseAnalystReply", () => {
  it("aceita o formato histórico de plano (sem kind)", () => {
    const reply = parseAnalystReply('{"subtarefas":[{"seq":1,"titulo":"A","scope":"fazer A","acceptance_criteria":["ok"]}]}')
    expect(reply.kind).toBe("plano")
    if (reply.kind !== "plano") throw new Error("inesperado")
    expect(reply.subtarefas).toHaveLength(1)
    expect(reply.subtarefas[0]!.titulo).toBe("A")
    expect(reply.subtarefas[0]!.acceptanceCriteria).toEqual(["ok"])
  })

  it("aceita plano com kind explícito", () => {
    const reply = parseAnalystReply('{"kind":"plano","subtarefas":[{"seq":1,"titulo":"A"}]}')
    expect(reply.kind).toBe("plano")
  })

  it("reconhece clarificação por kind perguntas", () => {
    const reply = parseAnalystReply('{"kind":"perguntas","resumo":"entendi X","perguntas":["prefere A ou B?","qual o prazo?"]}')
    expect(reply.kind).toBe("perguntas")
    if (reply.kind !== "perguntas") throw new Error("inesperado")
    expect(reply.resumo).toBe("entendi X")
    expect(reply.perguntas).toEqual(["prefere A ou B?", "qual o prazo?"])
  })

  it("reconhece clarificação pela presença do array perguntas (sem kind)", () => {
    const reply = parseAnalystReply('{"resumo":"r","perguntas":["uma?"]}')
    expect(reply.kind).toBe("perguntas")
  })

  it("tolera JSON embrulhado em cerca de código e texto ao redor", () => {
    const content = 'Claro! Segue o JSON:\n```json\n{"kind":"perguntas","resumo":"r","perguntas":["p?"]}\n```\nEspero a resposta.'
    const reply = parseAnalystReply(content)
    expect(reply.kind).toBe("perguntas")
  })

  it("resumo ausente vira string vazia", () => {
    const reply = parseAnalystReply('{"kind":"perguntas","perguntas":["p?"]}')
    if (reply.kind !== "perguntas") throw new Error("inesperado")
    expect(reply.resumo).toBe("")
  })

  it("rejeita clarificação sem perguntas válidas", () => {
    expect(() => parseAnalystReply('{"kind":"perguntas","resumo":"r","perguntas":["  "]}')).toThrow()
  })

  it("rejeita plano sem subtarefas", () => {
    expect(() => parseAnalystReply('{"kind":"plano","subtarefas":[]}')).toThrow()
  })

  it("rejeita resposta sem JSON", () => {
    expect(() => parseAnalystReply("nao tenho duvidas")).toThrow(/nao contem JSON/)
  })
})
