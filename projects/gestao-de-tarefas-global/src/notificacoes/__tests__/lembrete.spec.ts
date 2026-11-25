// @vitest-environment node
/**
 * Testes das funções puras do domínio de lembrete (macro 5, subtarefa 1).
 * Sem Nest, sem DB: apenas `Date` em fuso local (suíte raiz roda TZ=UTC).
 */
import { describe, expect, it } from "vitest"
import {
  calcularMomentoLembrete,
  lembreteVencidoAteAgora,
} from "../lembrete"

describe("calcularMomentoLembrete", () => {
  it("antecedência 60min: momento = prazo - 1h", () => {
    const prazo = new Date(2026, 11, 5, 14, 0, 0)
    expect(calcularMomentoLembrete(prazo, 60)).toEqual(
      new Date(2026, 11, 5, 13, 0, 0),
    )
  })

  it("antecedência 0: momento = o próprio prazo", () => {
    const prazo = new Date(2026, 11, 5, 14, 0, 0)
    expect(calcularMomentoLembrete(prazo, 0)).toEqual(prazo)
  })

  it("antecedência de 1 dia cruza a meia-noite", () => {
    const prazo = new Date(2026, 11, 5, 1, 30, 0)
    expect(calcularMomentoLembrete(prazo, 24 * 60)).toEqual(
      new Date(2026, 11, 4, 1, 30, 0),
    )
  })

  it("antecedência negativa é tratada como 0 (clamp defensivo)", () => {
    const prazo = new Date(2026, 11, 5, 14, 0, 0)
    expect(calcularMomentoLembrete(prazo, -15)).toEqual(prazo)
  })

  it("não muta os argumentos", () => {
    const prazo = new Date(2026, 11, 5, 14, 0, 0)
    calcularMomentoLembrete(prazo, 60)
    expect(prazo).toEqual(new Date(2026, 11, 5, 14, 0, 0))
  })
})

describe("lembreteVencidoAteAgora", () => {
  const prazo = new Date(2026, 11, 5, 14, 0, 0) // prazo 14:00

  it("antes da janela (agora < prazo-60min): falso", () => {
    expect(
      lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 5, 12, 59, 59)),
    ).toBe(false)
  })

  it("no exato do momento (agora = prazo-60min): verdadeiro", () => {
    expect(lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 5, 13, 0, 0))).toBe(true)
  })

  it("dentro da janela (prazo-60min < agora < prazo): verdadeiro", () => {
    expect(
      lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 5, 13, 30, 0)),
    ).toBe(true)
  })

  it("no exato do prazo (agora = prazo): falso — prazo já venceu", () => {
    expect(lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 5, 14, 0, 0))).toBe(false)
  })

  it("depois do prazo: falso (janela fechada — sem aviso pós-vencimento)", () => {
    expect(lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 5, 14, 0, 1))).toBe(false)
    expect(lembreteVencidoAteAgora(prazo, 60, new Date(2026, 11, 6, 9, 0, 0))).toBe(false)
  })

  it("antecedência 0: não dispara antes nem no exato do prazo (janela vazia)", () => {
    expect(lembreteVencidoAteAgora(prazo, 0, new Date(2026, 11, 5, 13, 59, 59))).toBe(false)
    expect(lembreteVencidoAteAgora(prazo, 0, new Date(2026, 11, 5, 14, 0, 0))).toBe(false)
  })
})
