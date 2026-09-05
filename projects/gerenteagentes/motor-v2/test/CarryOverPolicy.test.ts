/**
 * P1 (2026-09-05): carry-over de aprendizado entre entregas.
 * digestGateFailure remove ruído (HTML de componente) e mantém as linhas
 * acionáveis; formatCarryOver monta a seção de histórico do prompt.
 */
import { describe, expect, it } from "vitest"
import { digestGateFailure, formatCarryOver, type CarryOverEvent } from "../src/policies/CarryOverPolicy.js"

const NOISY_OUTPUT = [
  "stdout | src/telas/ClienteLista.test.tsx > renderiza lista",
  '<div class="MuiPaper-root">',
  '  <h1 class="MuiTypography-root">Clientes</h1>',
  '  <button class="MuiButton-root" tabindex="0">Novo</button>',
  "</div>",
  " FAIL  src/telas/ClienteLista.test.tsx > renderiza lista",
  "AssertionError: expected 3 to be 4",
  "    at Object.<anonymous> (src/telas/ClienteLista.test.tsx:42:18)",
  "    at /node_modules/@vitest/runner/dist/index.js:123:45",
  " Tests  1 failed | 11 passed (12)",
  " Duration  4.21s",
].join("\n")

describe("digestGateFailure", () => {
  it("mantém asserção e resumo, descarta markup HTML de componente", () => {
    const digest = digestGateFailure(NOISY_OUTPUT)
    expect(digest).toContain("AssertionError: expected 3 to be 4")
    expect(digest).toContain("FAIL")
    expect(digest).toContain("Tests  1 failed | 11 passed (12)")
    expect(digest).not.toContain("MuiButton-root")
    expect(digest).not.toContain("<div")
    expect(digest.length).toBeLessThan(NOISY_OUTPUT.length)
  })

  it("cai para o final da saída quando nada casa com os padrões", () => {
    const digest = digestGateFailure("linha sem padrão 1\nlinha sem padrão 2\nlinha sem padrão 3\nresumo final")
    expect(digest).toContain("resumo final")
  })

  it("respeita maxChars", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `AssertionError: expected ${i} to be ${i + 1}`).join("\n")
    const digest = digestGateFailure(huge, { maxLines: 200, maxChars: 500 })
    expect(digest.length).toBeLessThanOrEqual(500 + 40)
  })

  it("entrada vazia devolve marcador, não string vazia", () => {
    expect(digestGateFailure("")).toBe("(sem saída diagnóstica)")
  })
})

describe("formatCarryOver", () => {
  it("sem eventos relevantes devolve string vazia", () => {
    const events: CarryOverEvent[] = [
      { deliverNumber: 1, model: "m1", eventType: "delivery_started", reason: null },
      { deliverNumber: 1, model: "m1", eventType: "completed", reason: null },
    ]
    expect(formatCarryOver(events)).toBe("")
  })

  it("formata rejeições anteriores com modelo e motivo digerido", () => {
    const events: CarryOverEvent[] = [
      { deliverNumber: 1, model: "alibaba/qwen3.7-plus", eventType: "delivery_started", reason: null },
      { deliverNumber: 1, model: "alibaba/qwen3.7-plus", eventType: "gate_rejected", reason: NOISY_OUTPUT },
      { deliverNumber: 2, model: "openai/gpt-5.6-luna", eventType: "integration_gate_failed", reason: "Comando falhou na branch da tarefa (npm run test):\nAssertionError: expected true to be false" },
    ]
    const carryOver = formatCarryOver(events)
    expect(carryOver).toContain("Histórico de entregas anteriores DESTA subtarefa")
    expect(carryOver).toContain("Entrega 1, modelo alibaba/qwen3.7-plus: gate rejeitou")
    expect(carryOver).toContain("AssertionError: expected 3 to be 4")
    expect(carryOver).toContain("Entrega 2, modelo openai/gpt-5.6-luna: gate de integração falhou após merge na branch da tarefa")
    expect(carryOver).not.toContain("MuiButton-root")
  })

  it("eventos novos da P1 têm rótulo próprio", () => {
    const events: CarryOverEvent[] = [
      { deliverNumber: 3, model: null, eventType: "baseline_red", reason: "Falha reproduzida SEM as alterações do agente" },
      { deliverNumber: 4, model: null, eventType: "integration_conflict", reason: "Conflito ao integrar: a.ts" },
    ]
    const carryOver = formatCarryOver(events)
    expect(carryOver).toContain("baseline vermelho")
    expect(carryOver).toContain("conflito na integração com a branch da tarefa")
  })
})
