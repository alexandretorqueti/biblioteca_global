import { describe, expect, it } from "vitest"

import {
  DIAS_SEMANA_ISO,
  FREQUENCIAS_RECORRENCIA,
  chaveOcorrenciaDeterministica,
  diaIsoParaJs,
  isTimezoneIana,
  validarConfiguracaoSistema,
  validarRegraRecorrencia,
  calcularPrimeiraOcorrenciaFutura,
  ProcessadorRecorrencias,
  tarefaRecorrenteAtiva,
} from "../recorrencias"
import type { NovaTarefaRecorrente, OcorrenciaRecorrente, RepositorioRecorrencias, TarefaRecorrente } from "../recorrencias"

describe("timezone IANA do sistema", () => {
  it("aceita timezones IANA válidos", () => {
    expect(isTimezoneIana("America/Sao_Paulo")).toBe(true)
    expect(isTimezoneIana("UTC")).toBe(true)
    expect(isTimezoneIana("Europe/Lisbon")).toBe(true)
  })

  it("rejeita timezones inválidos", () => {
    expect(isTimezoneIana("")).toBe(false)
    expect(isTimezoneIana("America/Cidade_Inexistente")).toBe(false)
    expect(isTimezoneIana("GMT-3")).toBe(false)
    expect(isTimezoneIana(null)).toBe(false)
    expect(isTimezoneIana(123)).toBe(false)
  })

  it("valida a configuração única do sistema", () => {
    const ok = validarConfiguracaoSistema({ timezone: "America/Sao_Paulo" })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.valor.timezone).toBe("America/Sao_Paulo")

    const inv = validarConfiguracaoSistema({ timezone: "Horario/De/Brasilia" })
    expect(inv.ok).toBe(false)
    if (!inv.ok) expect(inv.erros.join(" ")).toMatch(/IANA/)

    expect(validarConfiguracaoSistema({}).ok).toBe(false)
    expect(validarConfiguracaoSistema(null).ok).toBe(false)
  })
})

describe("regra de recorrência", () => {
  it("suporta exatamente diária, semanal, mensal e anual", () => {
    expect(FREQUENCIAS_RECORRENCIA).toEqual(["diaria", "semanal", "mensal", "anual"])
    expect(validarRegraRecorrencia({ frequencia: "personalizada", horaExecucao: "09:00" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "quinzenal", horaExecucao: "09:00" }).ok).toBe(false)
  })

  it("diária preserva o horário de execução", () => {
    const r = validarRegraRecorrencia({ frequencia: "diaria", horaExecucao: "23:59" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.valor).toEqual({ frequencia: "diaria", horaExecucao: "23:59" })
  })

  it("semanal aceita múltiplos dias da semana (ISO 1..7)", () => {
    const r = validarRegraRecorrencia({ frequencia: "semanal", horaExecucao: "08:30", diasSemana: [7, 1, 3] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.valor.diasSemana).toEqual([1, 3, 7])

    const csv = validarRegraRecorrencia({ frequencia: "semanal", horaExecucao: "08:30", diasSemana: "1,3,5" })
    expect(csv.ok).toBe(true)
    if (csv.ok) expect(csv.valor.diasSemana).toEqual([1, 3, 5])

    expect(DIAS_SEMANA_ISO).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(diaIsoParaJs(7)).toBe(0) // domingo
    expect(diaIsoParaJs(1)).toBe(1) // segunda
  })

  it("semanal sem dias é inválida; dia fora de 1..7 é inválido", () => {
    expect(validarRegraRecorrencia({ frequencia: "semanal", horaExecucao: "08:00" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "semanal", horaExecucao: "08:00", diasSemana: [] }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "semanal", horaExecucao: "08:00", diasSemana: [0, 8] }).ok).toBe(false)
  })

  it("mensal exige dia do mês válido", () => {
    const ok = validarRegraRecorrencia({ frequencia: "mensal", horaExecucao: "07:00", diaMes: 31 })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.valor).toEqual({ frequencia: "mensal", horaExecucao: "07:00", diaMes: 31 })

    expect(validarRegraRecorrencia({ frequencia: "mensal", horaExecucao: "07:00" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "mensal", horaExecucao: "07:00", diaMes: 32 }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "mensal", horaExecucao: "07:00", diaMes: 0 }).ok).toBe(false)
  })

  it("anual exige mês e dia do mês válidos", () => {
    const ok = validarRegraRecorrencia({ frequencia: "anual", horaExecucao: "12:00", mes: 12, diaMes: 25 })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.valor).toEqual({ frequencia: "anual", horaExecucao: "12:00", diaMes: 25, mes: 12 })

    expect(validarRegraRecorrencia({ frequencia: "anual", horaExecucao: "12:00", diaMes: 25 }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "anual", horaExecucao: "12:00", mes: 13, diaMes: 25 }).ok).toBe(false)
  })

  it("horário de execução é obrigatório e no formato HH:MM", () => {
    expect(validarRegraRecorrencia({ frequencia: "diaria" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "diaria", horaExecucao: "24:00" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "diaria", horaExecucao: "9:00" }).ok).toBe(false)
    expect(validarRegraRecorrencia({ frequencia: "diaria", horaExecucao: "09:60" }).ok).toBe(false)
  })

  it("rejeita entradas não-objeto", () => {
    expect(validarRegraRecorrencia(null).ok).toBe(false)
    expect(validarRegraRecorrencia("diaria").ok).toBe(false)
  })
})

describe("identidade determinística da ocorrência", () => {
  it("mesma recorrência + mesmo instante produzem a mesma chave (Date ou ISO)", () => {
    const d = new Date("2026-10-22T12:00:00.000Z")
    const k1 = chaveOcorrenciaDeterministica(42, d)
    const k2 = chaveOcorrenciaDeterministica(42, "2026-10-22T12:00:00.000Z")
    const k3 = chaveOcorrenciaDeterministica(42, d)
    expect(k1).toBe(k2)
    expect(k1).toBe(k3)
    expect(k1).toBe("rec-42-20261022T120000Z")
  })

  it("ocorrências ou recorrências distintas produzem chaves distintas", () => {
    const a = chaveOcorrenciaDeterministica(42, "2026-10-22T12:00:00.000Z")
    const b = chaveOcorrenciaDeterministica(42, "2026-10-23T12:00:00.000Z")
    const c = chaveOcorrenciaDeterministica(43, "2026-10-22T12:00:00.000Z")
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it("rejeita entradas inválidas", () => {
    expect(() => chaveOcorrenciaDeterministica(42, "não-é-data")).toThrow()
    expect(() => chaveOcorrenciaDeterministica("", new Date())).toThrow()
  })

  it("chave cabe no varchar(160) persistido", () => {
    const k = chaveOcorrenciaDeterministica(Number.MAX_SAFE_INTEGER, "2026-10-22T12:00:00.000Z")
    expect(k.length).toBeLessThanOrEqual(160)
  })
})

describe("cálculo e processamento de ocorrências", () => {
  it("calcula a primeira ocorrência estritamente futura no timezone global", () => {
    const regra = { frequencia: "diaria" as const, horaExecucao: "09:00" }
    expect(calcularPrimeiraOcorrenciaFutura(regra, "America/Sao_Paulo", new Date("2026-10-22T12:00:00Z")).toISOString()).toBe("2026-10-23T12:00:00.000Z")
    expect(calcularPrimeiraOcorrenciaFutura(regra, "America/New_York", new Date("2026-03-08T06:00:00Z")).toISOString()).toBe("2026-03-08T13:00:00.000Z")
  })

  it("suporta múltiplos dias semanais, mensal e anual", () => {
    const agora = new Date("2026-10-22T12:00:00Z") // quinta-feira
    expect(calcularPrimeiraOcorrenciaFutura({ frequencia: "semanal", horaExecucao: "09:00", diasSemana: [1, 5] }, "America/Sao_Paulo", agora).toISOString()).toBe("2026-10-23T12:00:00.000Z")
    expect(calcularPrimeiraOcorrenciaFutura({ frequencia: "mensal", horaExecucao: "09:00", diaMes: 1 }, "America/Sao_Paulo", agora).toISOString()).toBe("2026-11-01T12:00:00.000Z")
    expect(calcularPrimeiraOcorrenciaFutura({ frequencia: "anual", horaExecucao: "09:00", diaMes: 1, mes: 1 }, "America/Sao_Paulo", agora).toISOString()).toBe("2027-01-01T12:00:00.000Z")
  })

  it("mantém aguardando como tarefa ativa", () => {
    expect(tarefaRecorrenteAtiva("aguardando")).toBe(true)
    expect(tarefaRecorrenteAtiva("concluida")).toBe(false)
    expect(tarefaRecorrenteAtiva("cancelada")).toBe(false)
  })

  it("bloqueia tarefa ativa e copia dados seletivamente após encerramento", async () => {
    let ativa = { id: 10, areaId: 2, criadoPorId: 7, titulo: "Base", descricao: "desc", prioridade: "alta" as const, createdAt: new Date("2026-10-22T12:00:00Z"), prazo: new Date("2026-10-23T12:00:00Z"), responsavelId: 8, tagIds: [3, 4], anexos: [{ nome: "nao copiar" }] }
    let ocorrencia: OcorrenciaRecorrente | undefined
    let geradas = 0
    const repo: RepositorioRecorrencias = {
      buscarTarefaBase: async (): Promise<TarefaRecorrente | null> => ativa,
      buscarTarefaAtiva: async (): Promise<TarefaRecorrente | null> => ativa,
      buscarRegra: async () => ({ frequencia: "diaria" as const, horaExecucao: "09:00" }),
      buscarOuCriarOcorrencia: async (valor: OcorrenciaRecorrente) => (ocorrencia ??= valor),
      criarTarefa: async (valor: NovaTarefaRecorrente) => { geradas += 1; expect(valor.tagIds).toEqual([3, 4]); expect(valor).not.toHaveProperty("anexos"); return { id: 20 } },
      marcarOcorrenciaGerada: async (_chave: string, tarefaId: number) => { if (ocorrencia) ocorrencia = { ...ocorrencia, status: "gerada", tarefaGeradaId: tarefaId } },
    }
    const processador = new ProcessadorRecorrencias(repo, "America/Sao_Paulo")
    expect((await processador.processar(5, new Date("2026-10-22T12:00:00Z"))).criada).toBe(false)
    ativa = { ...ativa, id: 10, status: undefined } as typeof ativa
    repo.buscarTarefaAtiva = async (): Promise<TarefaRecorrente | null> => null
    expect((await processador.processar(5, new Date("2026-10-22T12:00:00Z"))).criada).toBe(true)
    expect((await processador.processar(5, new Date("2026-10-22T12:00:00Z"))).criada).toBe(false)
    expect(geradas).toBe(1)
  })
})
