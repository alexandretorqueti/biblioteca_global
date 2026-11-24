// @vitest-environment node
/**
 * Testes do módulo puro de projeção financeira do projeto
 * `calculadora-de-investimentos-gabriel` (plano macro #6, posição 3/9 —
 * REQ-F-002, REQ-F-006, REQ-D-001, REQ-D-002, REQ-NF-003).
 *
 * Valores de referência conferidos à mão pelas fórmulas de juros compostos
 * (tolerância ≤ 0,01); módulos de cotação mockados para PROVAR que a
 * conversão anual→mensal usada é a compartilhada (REQ-F-006) — sem tocar na
 * exportação pública de `cotacoes/resolverCotacoes.ts`.
 *
 * Espelha o padrão de `__tests__/config.spec.ts` do próprio projeto.
 */
import { describe, expect, it, vi } from "vitest"
import {
  calcularProjecao,
  gerarSerieAnual,
  gerarSerieMensal,
  taxaMensalEmFracao,
  valorFuturoAportesMensais,
  valorFuturoDepositoUnico,
} from "../calculo/projecao"
import { converterAnualParaMensal } from "../cotacoes/resolverCotacoes"

/** Tolerância monetária exigida pela subtarefa. */
const TOL = 0.01

describe("valorFuturoDepositoUnico (juros compostos, P·(1+i)^n)", () => {
  it("P=1000, i=1% a.m., n=12 → 1126,825 (referência conferida)", () => {
    expect(valorFuturoDepositoUnico(1000, 0.01, 12)).toBeCloseTo(1126.825, 2)
    expect(Math.abs(valorFuturoDepositoUnico(1000, 0.01, 12) - 1126.825)).toBeLessThanOrEqual(TOL)
  })

  it("n=0 devolve o próprio principal; i=0 não corrói o valor", () => {
    expect(valorFuturoDepositoUnico(1000, 0.01, 0)).toBeCloseTo(1000, 6)
    expect(valorFuturoDepositoUnico(1000, 0, 36)).toBeCloseTo(1000, 6)
  })

  it("caso maior: 10000 a 0,9% a.m. por 24 meses → 12399,038 (conferido)", () => {
    // 1.009^24 = 1.23990380 → 10000 × 1.23990380 = 12399.038
    expect(valorFuturoDepositoUnico(10000, 0.009, 24)).toBeCloseTo(12399.038, 2)
  })
})

describe("valorFuturoAportesMensais (anuidade ordinária)", () => {
  it("PMT=100, i=1% a.m., n=12 → 1268,250 (fórmula ((1+i)^n−1)/i)", () => {
    const fv = valorFuturoAportesMensais(100, 0.01, 12)
    expect(fv).toBeCloseTo(1268.2503, 2)
    expect(Math.abs(fv - 1268.25)).toBeLessThanOrEqual(TOL)
  })

  it("n=1 degenera para o próprio aporte (convenção: aporte ao fim do mês)", () => {
    expect(valorFuturoAportesMensais(100, 0.01, 1)).toBeCloseTo(100, 6)
    expect(valorFuturoAportesMensais(250, 0.02, 1)).toBeCloseTo(250, 6)
  })

  it("i=0 vira soma simples PMT·n", () => {
    expect(valorFuturoAportesMensais(100, 0, 12)).toBeCloseTo(1200, 6)
  })
})

describe("conversão anual→mensal compartilhada (REQ-F-006)", () => {
  it("taxaMensalEmFracao usa converterAnualParaMensal — sem reimplementar a fórmula", async () => {
    // Mock do módulo de cotação: se o cálculo NÃO importar a função
    // compartilhada, o spy nunca é chamado e este teste falha.
    const spy = vi.fn(converterAnualParaMensal)
    vi.doMock("../cotacoes/resolverCotacoes", () => ({
      converterAnualParaMensal: spy,
    }))
    vi.resetModules()
    const modulo = await import("../calculo/projecao")
    const fracao = modulo.taxaMensalEmFracao({ taxaAnualPercentual: 12 })
    expect(spy).toHaveBeenCalledWith(12)
    expect(fracao).toBeCloseTo((Math.pow(1.12, 1 / 12) - 1), 10)
    vi.doUnmock("../cotacoes/resolverCotacoes")
    vi.resetModules()
  })

  it("taxa anual 12% a.a. → mensal por juros compostos ≈ 0,948880% a.m.", () => {
    expect(taxaMensalEmFracao({ taxaAnualPercentual: 12 })).toBeCloseTo(
      Math.pow(1.12, 1 / 12) - 1,
      10,
    )
  })

  it("taxa mensal direta entra em fração sem conversão", () => {
    expect(taxaMensalEmFracao({ taxaMensalPercentual: 1 })).toBeCloseTo(0.01, 12)
  })
})

describe("calcularProjecao — depósito único", () => {
  const simulacao = {
    modo: "unico",
    valorInicial: 1000,
    taxaMensalPercentual: 1,
    prazoAnos: 1,
  } as const

  it("valorFinal = 1126,825 para 12 meses a 1% a.m.", () => {
    expect(Math.abs(calcularProjecao(simulacao).valorFinal - 1126.825)).toBeLessThanOrEqual(TOL)
  })

  it("série mensal tem 12 pontos e anual tem 1 (prazo·12 e prazo)", () => {
    const r = calcularProjecao(simulacao)
    expect(r.pontosMensais).toHaveLength(12)
    expect(r.pontosAnuais).toHaveLength(1)
    expect(r.pontosMensais.map((p) => p.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it("últimos pontos mensal e anual coincidem com valorFinal (REQ-D-002)", () => {
    const r = calcularProjecao(simulacao)
    const ultimoMes = r.pontosMensais[r.pontosMensais.length - 1]!
    const ultimoAno = r.pontosAnuais[r.pontosAnuais.length - 1]!
    expect(Math.abs(ultimoMes.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ultimoAno.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
  })

  it("valorInvestido do depósito único é constante (sem aportes)", () => {
    const r = calcularProjecao(simulacao)
    for (const p of r.pontosMensais) expect(p.valorInvestido).toBe(1000)
  })
})

describe("calcularProjecao — aportes mensais", () => {
  const simulacao = {
    modo: "mensal",
    aporteMensal: 100,
    taxaMensalPercentual: 1,
    prazoAnos: 1,
  } as const

  it("valorFinal = 1268,250 (12 aportes a 1% a.m.)", () => {
    expect(Math.abs(calcularProjecao(simulacao).valorFinal - 1268.25)).toBeLessThanOrEqual(TOL)
  })

  it("últimos pontos e valorFinal coincidem; investido acumula 100/mês", () => {
    const r = calcularProjecao(simulacao)
    const ultimoMes = r.pontosMensais[r.pontosMensais.length - 1]!
    const ultimoAno = r.pontosAnuais[r.pontosAnuais.length - 1]!
    expect(Math.abs(ultimoMes.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ultimoAno.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
    expect(ultimoMes.valorInvestido).toBeCloseTo(1200, 6)
  })

  it("caso 10 anos: fórmula fechada e série convergem (<50ms, 360 meses)", () => {
    const r = calcularProjecao({
      modo: "mensal",
      aporteMensal: 500,
      taxaMensalPercentual: 0.9,
      prazoAnos: 10,
    })
    const esperado = valorFuturoAportesMensais(500, 0.009, 120)
    const ultimoMes = r.pontosMensais[r.pontosMensais.length - 1]!
    expect(Math.abs(r.valorFinal - esperado)).toBeLessThan(1e-6)
    expect(Math.abs(ultimoMes.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
  })
})

describe("consistência das séries e entrada por taxa anual", () => {
  it("projeção com taxaAnualPercentual usa a conversão e mantém séries consistentes", () => {
    const r = calcularProjecao({
      modo: "mensal",
      aporteMensal: 200,
      taxaAnualPercentual: 12,
      prazoAnos: 2,
    })
    expect(r.pontosMensais).toHaveLength(24)
    expect(r.pontosAnuais).toHaveLength(2)
    const ultimoMes = r.pontosMensais[23]!
    const ultimoAno = r.pontosAnuais[1]!
    expect(Math.abs(ultimoMes.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
    expect(Math.abs(ultimoAno.valor - r.valorFinal)).toBeLessThanOrEqual(TOL)
    // mês 12 da série anual == mês 12 da mensal (colheita por construção)
    expect(r.pontosAnuais[0]!.mes).toBe(12)
    expect(r.pontosAnuais[0]!.valor).toBe(r.pontosMensais[11]!.valor)
  })

  it("pontos anuais são subconjunto exato dos mensais (meses 12, 24, ...)", () => {
    const simulacao = {
      modo: "mensal",
      aporteMensal: 150,
      taxaMensalPercentual: 0.5,
      prazoAnos: 3,
    } as const
    const mensal = gerarSerieMensal(simulacao)
    const anual = gerarSerieAnual(simulacao)
    expect(anual).toHaveLength(3)
    anual.forEach((ponto, idx) => {
      expect(ponto).toEqual(mensal[(idx + 1) * 12 - 1])
    })
  })
})

describe("desempenho (REQ-NF-003)", () => {
  it("projeção de 360 meses (30 anos) calcula em <50ms", () => {
    const inicio = performance.now()
    const r = calcularProjecao({
      modo: "mensal",
      aporteMensal: 300,
      taxaMensalPercentual: 1,
      prazoAnos: 30,
    })
    const duracaoMs = performance.now() - inicio
    expect(r.pontosMensais).toHaveLength(360)
    expect(r.pontosAnuais).toHaveLength(30)
    expect(duracaoMs).toBeLessThan(50)
  })
})

describe("validação de entrada", () => {
  it("rejeita prazo não-inteiro ou < 1", () => {
    expect(() =>
      calcularProjecao({ modo: "unico", valorInicial: 1000, taxaMensalPercentual: 1, prazoAnos: 0 }),
    ).toThrow(RangeError)
    expect(() =>
      calcularProjecao({ modo: "unico", valorInicial: 1000, taxaMensalPercentual: 1, prazoAnos: 1.5 }),
    ).toThrow(RangeError)
  })

  it("exige exatamente uma taxa (nem nenhuma, nem ambas)", () => {
    expect(() =>
      calcularProjecao({ modo: "unico", valorInicial: 1000, prazoAnos: 1 } as unknown as Parameters<typeof calcularProjecao>[0]),
    ).toThrow(RangeError)
    expect(() =>
      calcularProjecao({
        modo: "unico",
        valorInicial: 1000,
        taxaMensalPercentual: 1,
        taxaAnualPercentual: 12,
        prazoAnos: 1,
      } as unknown as Parameters<typeof calcularProjecao>[0]),
    ).toThrow(RangeError)
  })

  it("rejeita valor ou taxa negativos", () => {
    expect(() =>
      calcularProjecao({ modo: "unico", valorInicial: -1, taxaMensalPercentual: 1, prazoAnos: 1 }),
    ).toThrow(RangeError)
    expect(() =>
      calcularProjecao({ modo: "mensal", aporteMensal: 100, taxaMensalPercentual: -0.1, prazoAnos: 1 }),
    ).toThrow(RangeError)
  })
})
