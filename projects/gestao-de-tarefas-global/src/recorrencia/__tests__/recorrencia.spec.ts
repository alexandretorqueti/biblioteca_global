// @vitest-environment node
/**
 * Unit tests do domínio de recorrência (funções puras — macro 4, subtarefa 1).
 *
 * Cobrem o aceite: diária (consecutiva na hora definida, desde > dataInicio),
 * semanal (somente dias selecionados, na hora), mensal (1/mês no dia de
 * dataInicio, clamp ao último dia), encerramento (dataFim), horaDoDia NULL,
 * idempotência (ocorrência estritamente posterior a `desde`) e as validações
 * de regra + o mapeamento regra → instância.
 *
 * A suíte raiz roda com TZ=UTC (vitest.config.ts) — as `Date` locais dos
 * testes são, portanto, UTC.
 */
import { describe, expect, it } from "vitest"
import { calcularProximaGeracao } from "../proxima-geracao"
import { montarInstancia } from "../instancia"
import { validarRegra } from "../validar-regra"
import type { RegraRecorrencia } from "../tipos"

/** "YYYY-MM-DDTHH:MM:SS" em horário local (= UTC na suíte). */
function local(iso: string): Date {
  return new Date(iso)
}

/** Data local → "YYYY-MM-DD" (sem conversão de fuso). */
function fmtData(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function regra(overrides: Partial<RegraRecorrencia> = {}): RegraRecorrencia {
  return {
    id: 11,
    organizacaoId: 3,
    titulo: "Regra teste",
    descricao: null,
    areaId: 5,
    responsavelId: 7,
    frequencia: "diaria",
    diasSemana: null,
    horaDoDia: null,
    dataInicio: "2026-12-01",
    dataFim: null,
    ativa: true,
    proximaGeracao: null,
    ...overrides,
  }
}

describe("calcularProximaGeracao — diária", () => {
  it("gera na hora definida a partir da dataInicio (inclusive o dia inicial)", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: "09:00:00", dataInicio: "2026-12-01" })
    expect(calcularProximaGeracao(r, local("2026-11-30T23:59:59"))?.toISOString())
      .toBe("2026-12-01T09:00:00.000Z")
  })

  it("ocorrências consecutivas na hora, inclusive quando desde > dataInicio", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: "09:00:00", dataInicio: "2026-12-01" })
    let cursor = local("2026-12-05T10:00:00") // depois da ocorrência do dia
    const geradas: string[] = []
    for (let i = 0; i < 3; i++) {
      const prox = calcularProximaGeracao(r, cursor)
      expect(prox).not.toBeNull()
      geradas.push(prox!.toISOString())
      cursor = prox!
    }
    expect(geradas).toEqual([
      "2026-12-06T09:00:00.000Z",
      "2026-12-07T09:00:00.000Z",
      "2026-12-08T09:00:00.000Z",
    ])
  })

  it("horaDoDia NULL = 00:00", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: null, dataInicio: "2026-12-01" })
    const prox = calcularProximaGeracao(r, local("2026-12-01T00:00:01"))
    expect(prox?.toISOString()).toBe("2026-12-02T00:00:00.000Z")
  })

  it("idempotência: reavaliar no próprio instante de geração não duplica", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: "09:00:00", dataInicio: "2026-12-01" })
    const prox = calcularProximaGeracao(r, local("2026-12-02T08:00:00"))!
    // O agendador grava proximaGeracao e reprocessa (ex.: restart):
    const deNovo = calcularProximaGeracao(r, prox)
    expect(deNovo).not.toBeNull()
    expect(deNovo!.getTime()).toBe(prox.getTime() + 24 * 3600 * 1000)
  })
})

describe("calcularProximaGeracao — semanal", () => {
  it("gera somente nos dias selecionados, na hora definida", () => {
    // 2026-11-30 = segunda; 2026-12-01 = terça; 2026-12-02 = quarta; 04/12 = sexta.
    // [1, 3, 5] = seg/qua/sex.
    const r = regra({ frequencia: "semanal", diasSemana: [1, 3, 5], horaDoDia: "08:30:00", dataInicio: "2026-12-01" })
    // desde seg 30/11 12:00, dataInicio = ter 01/12 (não selecionado) → qua 02/12
    expect(calcularProximaGeracao(r, local("2026-11-30T12:00:00"))?.toISOString())
      .toBe("2026-12-02T08:30:00.000Z")
    // de qua 02/12 12:00 (após a ocorrência das 08:30) → sex 04/12
    expect(calcularProximaGeracao(r, local("2026-12-02T12:00:00"))?.toISOString())
      .toBe("2026-12-04T08:30:00.000Z")
  })

  it("dias fora da seleção nunca são retornados (fim de semana p/ dias úteis)", () => {
    const r = regra({ frequencia: "semanal", diasSemana: [1, 2, 3, 4, 5], horaDoDia: null, dataInicio: "2026-12-01" })
    // sexta 04/12 → segunda 07/12 (sábado/domingo nunca aparecem)
    const prox = calcularProximaGeracao(r, local("2026-12-04T18:00:00"))!
    expect(prox.toISOString()).toBe("2026-12-07T00:00:00.000Z")
    expect(prox.getDay()).toBe(1)
  })

  it("semanal com desde após a ocorrência do dia selecionado salta para o próximo", () => {
    // [1] = segunda. Segunda-feira: 30/11 e 07/12/2026.
    const r = regra({ frequencia: "semanal", diasSemana: [1], horaDoDia: "09:00:00", dataInicio: "2026-11-30" })
    // desde = exatamente o instante da ocorrência de seg 30/11 → próxima seg 07/12
    expect(calcularProximaGeracao(r, local("2026-11-30T09:00:00"))?.toISOString())
      .toBe("2026-12-07T09:00:00.000Z")
  })
})

describe("calcularProximaGeracao — mensal", () => {
  it("1 ocorrência por mês no dia de dataInicio", () => {
    const r = regra({ frequencia: "mensal", dataInicio: "2026-12-15", horaDoDia: "07:00:00" })
    expect(calcularProximaGeracao(r, local("2026-11-20T00:00:00"))?.toISOString())
      .toBe("2026-12-15T07:00:00.000Z")
    expect(calcularProximaGeracao(r, local("2026-12-15T07:00:00"))?.toISOString())
      .toBe("2027-01-15T07:00:00.000Z")
  })

  it("clamp: dia 31 em fevereiro gera no último dia do mês", () => {
    const r = regra({ frequencia: "mensal", dataInicio: "2026-01-31" })
    // 31/01 → 28/02/2026 (féb/26 sem 29)
    expect(fmtData(calcularProximaGeracao(r, local("2026-01-31T00:00:00"))!)).toBe("2026-02-28")
    // 28/02 → 31/03
    expect(fmtData(calcularProximaGeracao(r, local("2026-02-28T00:00:00"))!)).toBe("2026-03-31")
    // ano bissexto: 29/02
    const bissexto = regra({ frequencia: "mensal", dataInicio: "2028-01-31" })
    expect(fmtData(calcularProximaGeracao(bissexto, local("2028-01-31T00:00:00"))!)).toBe("2028-02-29")
  })

  it("clamp não gera ocorrência de mês já passado (desde dia 28/02 com diaInicio 31)", () => {
    const r = regra({ frequencia: "mensal", dataInicio: "2026-01-31" })
    // desde 28/02/2026 00:00 → a ocorrência de 28/02 já passou (é "agora"
    // na hora 00:00? não: ocorrência 28/02 00:00:00 é == desde, não > desde)
    // → próxima é 31/03
    expect(fmtData(calcularProximaGeracao(r, local("2026-02-28T00:00:01"))!)).toBe("2026-03-31")
  })

  it("dataFim = dia do clamp mensal: última ocorrência no clamp; depois, null", () => {
    const r = regra({ frequencia: "mensal", dataInicio: "2026-01-31", dataFim: "2026-02-28" })
    // dia 31 clampa para 28/02, que é o próprio dataFim → última geração
    expect(fmtData(calcularProximaGeracao(r, local("2026-01-31T00:00:00"))!)).toBe("2026-02-28")
    // após 28/02, a próxima (31/03) ultrapassa dataFim → null
    expect(calcularProximaGeracao(r, local("2026-02-28T00:00:00"))).toBeNull()
  })
})

describe("calcularProximaGeracao — encerramento (dataFim)", () => {
  it("dataFim nula = geração contínua (meses à frente)", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: null, dataInicio: "2026-12-01", dataFim: null })
    const prox = calcularProximaGeracao(r, local("2027-03-01T00:00:00"))!
    expect(prox.toISOString()).toBe("2027-03-02T00:00:00.000Z")
  })

  it("diária: última ocorrência no próprio dia de dataFim; depois, null", () => {
    const r = regra({ frequencia: "diaria", horaDoDia: "09:00:00", dataInicio: "2026-12-01", dataFim: "2026-12-03" })
    expect(calcularProximaGeracao(r, local("2026-12-02T09:00:00"))?.toISOString())
      .toBe("2026-12-03T09:00:00.000Z")
    expect(calcularProximaGeracao(r, local("2026-12-03T09:00:00"))).toBeNull()
  })

  it("semanal: dia selecionado após dataFim → null", () => {
    const r = regra({ frequencia: "semanal", diasSemana: [1], horaDoDia: null, dataInicio: "2026-12-01", dataFim: "2026-12-05" })
    // seg 07/12 > dataFim 05/12
    expect(calcularProximaGeracao(r, local("2026-12-01T00:00:00"))).toBeNull()
  })
})

describe("validarRegra", () => {
  it("aceita regra diária sem diasSemana", () => {
    expect(validarRegra(regra({ frequencia: "diaria", diasSemana: null }))).toEqual([])
  })

  it("aceita semanal com diasSemana válidos", () => {
    expect(validarRegra(regra({ frequencia: "semanal", diasSemana: [0, 2, 6] }))).toEqual([])
  })

  it("rejeita semanal sem diasSemana (null/vazio)", () => {
    const errosNull = validarRegra(regra({ frequencia: "semanal", diasSemana: null }))
    expect(errosNull).toHaveLength(1)
    expect(errosNull[0]).toMatch(/diasSemana/)
    const errosVazio = validarRegra(regra({ frequencia: "semanal", diasSemana: [] }))
    expect(errosVazio).toHaveLength(1)
  })

  it("rejeita diasSemana fora de 0–6", () => {
    const erros = validarRegra(regra({ frequencia: "semanal", diasSemana: [1, 8] }))
    expect(erros).toHaveLength(1)
    expect(erros[0]).toMatch(/0 a 6/)
    expect(validarRegra(regra({ frequencia: "semanal", diasSemana: [-1] }))).toHaveLength(1)
  })

  it("rejeita dataFim < dataInicio e dataInicio ausente", () => {
    const erros = validarRegra(regra({ dataInicio: "2026-12-01", dataFim: "2026-11-30" }))
    expect(erros).toHaveLength(1)
    expect(erros[0]).toMatch(/dataFim/)
    expect(validarRegra(regra({ dataInicio: "" as unknown as string }))).toContain("dataInicio é obrigatória")
  })

  it("aceita dataFim === dataInicio (minDate ≥)", () => {
    expect(validarRegra(regra({ dataInicio: "2026-12-01", dataFim: "2026-12-01" }))).toEqual([])
  })
})

describe("montarInstancia", () => {
  it("preserva organização/área/responsável/título, seta vínculo e prazo NULL", () => {
    const r = regra({
      id: 42,
      organizacaoId: 9,
      titulo: "Boletim semanal",
      descricao: "gerar boletim",
      areaId: 14,
      responsavelId: 21,
      frequencia: "semanal",
      diasSemana: [2],
    })
    const inst = montarInstancia(r, local("2026-12-02T08:30:00"))
    expect(inst).toEqual({
      organizacaoId: 9,
      titulo: "Boletim semanal",
      descricao: "gerar boletim",
      areaId: 14,
      responsavelId: 21,
      criadoPorId: 21, // DECISÃO: NOT NULL; regra não tem autor
      prioridade: "media", // default do schema
      prazo: null, // DECISÃO: sem prazo → sem lembrete (tarefa 5)
      status: "aberta",
      regraRecorrenciaId: 42, // vínculo instância ↔ regra
    })
  })
})
