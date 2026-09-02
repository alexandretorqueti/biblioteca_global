import { describe, expect, it } from "vitest"
import { classifyAnalystParseFailure, parseAnalystReply, safeParseAnalystReply } from "../src/planning/AnalystReply.js"

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

describe("safeParseAnalystReply", () => {
  it("retorna o reply em caso valido (sem lançar)", () => {
    const parsed = safeParseAnalystReply('{"subtarefas":[{"seq":1,"titulo":"A"}]}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("inesperado")
    expect(parsed.reply.kind).toBe("plano")
  })

  it("classifica JSON cortado no meio de string como truncado", () => {
    // Caso real de 2026-09-01: geração estourou o teto de saída no meio do scope.
    const content = '{"subtarefas":[{"seq":1,"titulo":"A","scope":"implementar o fluxo completo de validacao'
    const parsed = safeParseAnalystReply(content)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("inesperado")
    expect(parsed.failure.kind).toBe("truncated")
  })

  it("classifica JSON interrompido entre tokens como truncado", () => {
    const parsed = safeParseAnalystReply('{"subtarefas":[{"seq":1')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("inesperado")
    expect(parsed.failure.kind).toBe("truncated")
  })

  it("classifica texto sem JSON como invalido (nao truncado)", () => {
    const parsed = safeParseAnalystReply("nao tenho duvidas, pode seguir")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("inesperado")
    expect(parsed.failure.kind).toBe("invalid")
  })

  it("classifica plano sem subtarefas como invalido", () => {
    const parsed = safeParseAnalystReply('{"kind":"plano","subtarefas":[]}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("inesperado")
    expect(parsed.failure.kind).toBe("invalid")
  })
})

describe("classifyAnalystParseFailure", () => {
  it("detecta truncamento por formato quando nao ha chave de fechamento", () => {
    const failure = classifyAnalystParseFailure('{"subtarefas": [', new Error("qualquer outro erro"))
    expect(failure.kind).toBe("truncated")
  })

  it("mantem erro semantico como invalido quando o JSON fecha", () => {
    const failure = classifyAnalystParseFailure('{"kind":"perguntas","perguntas":["  "]}', new Error("Clarificação sem perguntas válidas"))
    expect(failure.kind).toBe("invalid")
  })
})
