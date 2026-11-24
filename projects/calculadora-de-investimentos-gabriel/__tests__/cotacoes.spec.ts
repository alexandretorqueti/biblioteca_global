// @vitest-environment node
/**
 * Testes do resolvedor de cotações do projeto
 * `calculadora-de-investimentos-gabriel` (plano macro #6, posição 2/9 —
 * REQ-F-003/REQ-F-005/REQ-F-006, REQ-I-001, REQ-D-003, REQ-NF-003).
 *
 * Fixtures JSON no formato real da resposta SGS
 * (`[{"data":"dd/mm/aaaa","valor":"..."}]`, verificados ao vivo em
 * 2026-11-23 — docs/DECISOES-COTACOES.md §2). `fetch` e relógio mockados;
 * nenhuma chamada de rede nos testes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAPEAMENTO_COTACOES,
  anualizarTaxaDi,
  calcularVariacaoHistorica,
  converterAnualParaMensal,
  limparCacheCotacoes,
  resolverCotacao,
  urlSerieSgs,
  type FetchDeCotacao,
} from "../cotacoes/resolverCotacoes"
import fixtureCdi from "./fixtures/sgs-cdi-12.json"
import fixtureIbovespa from "./fixtures/sgs-ibovespa-33-mensal.json"
import fixtureIpca from "./fixtures/sgs-ipca-13522.json"
import fixtureSelic from "./fixtures/sgs-selic-4389.json"

/** Resposta SGS fake: serializa o fixture no formato real do endpoint. */
function fetchFixture(corpo: unknown): FetchDeCotacao {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(corpo),
  }))
}

/** Relógio fake injetável: `agora()` retorna o valor ajustado por `setar`. */
function criarRelogio(inicialMs: number) {
  let atual = inicialMs
  return {
    agora: () => atual,
    avancar(ms: number) {
      atual += ms
    },
  }
}

const TEMPO_VALIDO_MS = Date.UTC(2026, 10, 23, 12, 0, 0)

beforeEach(() => {
  limparCacheCotacoes()
})

describe("funções puras de conversão", () => {
  it("anual→mensal por juros compostos: (1+anual/100)^(1/12)-1, em %", () => {
    for (const anual of [0, 0.5, 4.63, 13.65, 15, 100]) {
      const esperado = (Math.pow(1 + anual / 100, 1 / 12) - 1) * 100
      expect(converterAnualParaMensal(anual)).toBeCloseTo(esperado, 12)
    }
  })

  it("anualização de taxa % d.i. em 252 dias úteis", () => {
    const esperado = (Math.pow(1 + 0.050788 / 100, 252) - 1) * 100
    expect(anualizarTaxaDi(0.050788)).toBeCloseTo(esperado, 12)
  })

  it("variação histórica: (ultimo/anterior12m - 1) × 100", () => {
    expect(calcularVariacaoHistorica(180000, 148000)).toBeCloseTo(
      (180000 / 148000 - 1) * 100,
      12,
    )
  })

  it("mapeamento codigoFonte→serie exportado com os códigos verificados", () => {
    expect(MAPEAMENTO_COTACOES.CDI?.serie).toBe("12")
    expect(MAPEAMENTO_COTACOES.SELIC?.serie).toBe("4389")
    expect(MAPEAMENTO_COTACOES.IPCA?.serie).toBe("13522")
    expect(MAPEAMENTO_COTACOES.IBOV?.serie).toBe("33")
    expect(MAPEAMENTO_COTACOES.IBOV?.usaVariacaoHistorica).toBe(true)
    // Alternativa BrasilAPI documentada por índice (não chamada pelo módulo).
    for (const sigla of ["CDI", "SELIC", "IPCA", "IBOV"] as const) {
      expect(MAPEAMENTO_COTACOES[sigla]?.alternativaBrasilApi).toContain("brasilapi.com.br")
    }
  })

  it("URL SGS no padrão verificado ao vivo", () => {
    expect(urlSerieSgs("12", 2)).toBe(
      "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados/ultimos/2?formato=json",
    )
  })
})

describe("resolverCotacao — taxas da fonte com fixture SGS", () => {
  it("CDI (série 12, % d.i.): anualiza em 252 d.u. e deriva a mensal pela fórmula", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const resultado = await resolverCotacao(
      { sigla: "CDI" },
      { fetchFn: fetchFixture(fixtureCdi), agora: relogio.agora },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return

    const di = 0.050788
    const anualEsperado = (Math.pow(1 + di / 100, 252) - 1) * 100
    expect(resultado.cotacao.taxaAnual).toBeCloseTo(anualEsperado, 9)
    expect(resultado.cotacao.taxaMensal).toBeCloseTo(
      (Math.pow(1 + resultado.cotacao.taxaAnual / 100, 1 / 12) - 1) * 100,
      9,
    )
    expect(resultado.cotacao.sigla).toBe("CDI")
    expect(resultado.cotacao.fonte).toContain("SGS")
    expect(resultado.cotacao.capturadaEm).toBe(new Date(TEMPO_VALIDO_MS).toISOString())
  })

  it("Selic (série 4389): taxa anual direta da fonte e mensal derivada pela fórmula", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const resultado = await resolverCotacao(
      { sigla: "SELIC" },
      { fetchFn: fetchFixture(fixtureSelic), agora: relogio.agora },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return

    expect(resultado.cotacao.taxaAnual).toBeCloseTo(13.65, 9)
    // Asserção direta contra a fórmula, tolerância 1e-9 (critério de aceite).
    expect(resultado.cotacao.taxaMensal).toBeCloseTo(
      (Math.pow(1 + 13.65 / 100, 1 / 12) - 1) * 100,
      9,
    )
    expect(resultado.cotacao.fonte).toContain("4389")
  })

  it("IPCA (série 13522, acumulado 12m): taxa anual direta e mensal derivada", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const resultado = await resolverCotacao(
      { sigla: "IPCA" },
      { fetchFn: fetchFixture(fixtureIpca), agora: relogio.agora },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return

    expect(resultado.cotacao.taxaAnual).toBeCloseTo(4.63, 9)
    expect(resultado.cotacao.taxaMensal).toBeCloseTo(
      (Math.pow(1 + 4.63 / 100, 1 / 12) - 1) * 100,
      9,
    )
  })

  it("Ibovespa (usaVariacaoHistorica): (ultimo/valor há 12 meses - 1) × 100", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const resultado = await resolverCotacao(
      { sigla: "IBOV" },
      { fetchFn: fetchFixture(fixtureIbovespa), agora: relogio.agora },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return

    // Fixture mensal: último = 180000 (01/11/2026); último ≤ 12m antes =
    // 148000 (01/11/2025). Critério documentado em DECISOES-COTACOES.md §4.
    expect(resultado.cotacao.taxaAnual).toBeCloseTo((180000 / 148000 - 1) * 100, 9)
    expect(resultado.cotacao.taxaMensal).toBeCloseTo(
      (Math.pow(1 + resultado.cotacao.taxaAnual / 100, 1 / 12) - 1) * 100,
      9,
    )
    expect(resultado.cotacao.fonte).toContain("33")
  })
})

describe("resolverCotacao — falhas, timeout e fallback", () => {
  it("HTTP 500 sem fallback → CotacaoError FONTE_INDISPONIVEL (sem erro cru)", async () => {
    const fetchErro: FetchDeCotacao = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "",
    }))
    const resultado = await resolverCotacao({ sigla: "CDI" }, { fetchFn: fetchErro })
    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.error.code).toBe("FONTE_INDISPONIVEL")
    expect(typeof resultado.error.mensagem).toBe("string")
  })

  it("HTTP 500 com fallback → taxa do chamador com fonte marcada como fallback", async () => {
    const fetchErro: FetchDeCotacao = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "",
    }))
    const resultado = await resolverCotacao(
      { sigla: "SELIC", taxaAnualFallback: 15 },
      { fetchFn: fetchErro, agora: () => TEMPO_VALIDO_MS },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.cotacao.taxaAnual).toBe(15)
    expect(resultado.cotacao.fonte).toMatch(/^fallback.*FONTE_INDISPONIVEL/)
    expect(resultado.cotacao.taxaMensal).toBeCloseTo(
      (Math.pow(1 + 15 / 100, 1 / 12) - 1) * 100,
      9,
    )
  })

  it("timeout do fetch (AbortController) → CotacaoError TIMEOUT", async () => {
    // Fetch que só rejeita quando o sinal de abort dispara (AbortError).
    const fetchLento: FetchDeCotacao = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("o sinal foi abortado"), { name: "AbortError" }))
        })
      })
    const resultado = await resolverCotacao(
      { sigla: "CDI" },
      { fetchFn: fetchLento, timeoutMs: 20 },
    )
    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.error.code).toBe("TIMEOUT")
  })

  it("timeout com fallback → usa fallback mantendo o código TIMEOUT na fonte", async () => {
    const fetchLento: FetchDeCotacao = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("o sinal foi abortado"), { name: "AbortError" }))
        })
      })
    const resultado = await resolverCotacao(
      { sigla: "CDI", taxaAnualFallback: 14.9 },
      { fetchFn: fetchLento, timeoutMs: 20, agora: () => TEMPO_VALIDO_MS },
    )
    expect(resultado.ok).toBe(true)
    if (!resultado.ok) return
    expect(resultado.cotacao.taxaAnual).toBe(14.9)
    expect(resultado.cotacao.fonte).toMatch(/^fallback.*TIMEOUT/)
  })

  it("corpo sem dados ([]) → CotacaoError DADO_AUSENTE", async () => {
    const resultado = await resolverCotacao(
      { sigla: "IPCA" },
      { fetchFn: fetchFixture([]) },
    )
    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.error.code).toBe("DADO_AUSENTE")
  })

  it("corpo sem dados com fallback → fallback; e erro de rede vira FONTE_INDISPONIVEL", async () => {
    const comFallback = await resolverCotacao(
      { sigla: "IPCA", taxaAnualFallback: 4.5 },
      { fetchFn: fetchFixture([]), agora: () => TEMPO_VALIDO_MS },
    )
    expect(comFallback.ok).toBe(true)
    if (comFallback.ok) expect(comFallback.cotacao.fonte).toMatch(/^fallback/)

    const fetchRede: FetchDeCotacao = vi.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    const semFallback = await resolverCotacao({ sigla: "CDI" }, { fetchFn: fetchRede })
    expect(semFallback.ok).toBe(false)
    if (semFallback.ok) return
    expect(semFallback.error.code).toBe("FONTE_INDISPONIVEL")
  })

  it("sigla sem mapeamento → CotacaoError DADO_AUSENTE tipado", async () => {
    const resultado = await resolverCotacao(
      { sigla: "NAOEXISTE" },
      { fetchFn: fetchFixture(fixtureCdi) },
    )
    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.error.code).toBe("DADO_AUSENTE")
  })
})

describe("resolverCotacao — cache em memória (TTL default 10min)", () => {
  it("2ª chamada dentro do TTL não invoca fetch; após expirar, busca de novo", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const fetchFn = fetchFixture(fixtureSelic)

    const primeira = await resolverCotacao(
      { sigla: "SELIC" },
      { fetchFn, agora: relogio.agora },
    )
    expect(primeira.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    // Dentro da janela de 10 minutos: vem do cache, fetch não é chamado.
    relogio.avancar(9 * 60 * 1000)
    const segunda = await resolverCotacao(
      { sigla: "SELIC" },
      { fetchFn, agora: relogio.agora },
    )
    expect(segunda.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    if (primeira.ok && segunda.ok) {
      expect(segunda.cotacao).toEqual(primeira.cotacao)
    }

    // Passado o TTL: busca novamente na fonte.
    relogio.avancar(2 * 60 * 1000)
    const terceira = await resolverCotacao(
      { sigla: "SELIC" },
      { fetchFn, agora: relogio.agora },
    )
    expect(terceira.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("TTL configurável: janela custom expira antes do default", async () => {
    const relogio = criarRelogio(TEMPO_VALIDO_MS)
    const fetchFn = fetchFixture(fixtureIpca)

    await resolverCotacao({ sigla: "IPCA" }, { fetchFn, agora: relogio.agora, ttlMs: 60_000 })
    relogio.avancar(61_000)
    await resolverCotacao({ sigla: "IPCA" }, { fetchFn, agora: relogio.agora, ttlMs: 60_000 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("fallback NÃO é cacheado: chamada seguinte tenta a fonte de novo", async () => {
    const fetchErro: FetchDeCotacao = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => "",
    }))
    await resolverCotacao({ sigla: "CDI", taxaAnualFallback: 14 }, { fetchFn: fetchErro })
    await resolverCotacao({ sigla: "CDI", taxaAnualFallback: 14 }, { fetchFn: fetchErro })
    expect(fetchErro).toHaveBeenCalledTimes(2)
  })
})
