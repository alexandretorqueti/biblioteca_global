// @vitest-environment node
/**
 * Testes unitários do RecorrenciaAgendadorService (macro 4, subtarefa 3) —
 * repo/transactions fake + `now()` injetado (padrão dos specs de fluxo do
 * projeto; sem MySQL).
 *
 * O fake reproduz a semântica do claim `SELECT ... FOR UPDATE` com um mutex
 * assíncrono POR REGRA: a transação que_claima primeiro bloqueia as demais
 * até o commit; a segunda leitura do concorrente vê o cursor já avançado e
 * não gera — é exatamente o comportamento do FOR UPDATE + lock de linha que
 * dá idempotência sob restart/dual blue-green.
 *
 * Cobre o aceite:
 * - regra vencida gera exatamente 1 instância com vínculo regraRecorrenciaId
 *   e área/responsável/título copiados;
 * - duas execuções concorrentes sobre a mesma regra → 1 instância apenas;
 * - diária/semanal/mensal geram somente quando o cursor vence (semanal
 *   respeita dias selecionados via cálculo da subtarefa 1);
 * - dataFim: última ocorrência dentro do limite é gerada, regra vira
 *   ativa=false e nada mais é gerado;
 * - cursor NULL (bootstrap): calcula a partir de agora, SEM instância e sem
 *   catch-up retroativo;
 * - dataFim editado para trás: encerra sem gerar;
 * - erro injetado em uma regra: Logger.error estruturado, cursor não avança,
 *   demais regras do tick continuam;
 * - timer unref + clearInterval no onModuleDestroy; flag env desliga.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecorrenciaAgendadorService } from "../recorrencia-agendador.service"
import type {
  RepositorioRecorrenciaAgendador,
  RegraVencidaResumo,
  TransacaoRecorrencia,
} from "../recorrencia-agendador.repositorio"
import type { RegraRecorrencia } from "../../../../../../projects/gestao-de-tarefas-global/src/recorrencia/tipos"
import type { InstanciaTarefa } from "../../../../../../projects/gestao-de-tarefas-global/src/recorrencia/instancia"
import {
  formatarDatetimeMysql,
  parseDatetimeMysql,
} from "../datetime-mysql"

// ============================================================================
// Fake do repositório (mutex por regra = SELECT ... FOR UPDATE)
// ============================================================================

interface InstanciaRegistrada {
  regraId: number
  instancia: InstanciaTarefa
}

interface FakeApi {
  repo: RepositorioRecorrenciaAgendador
  regras: Map<number, RegraRecorrencia>
  instancias: InstanciaRegistrada[]
  /** ids das regras cuja transação falha (erro injetado). */
  falhas: Set<number>
  /** Contagem de claims (leitura FOR UPDATE) por regra. */
  claims: Map<number, number>
}

function criarFake(): FakeApi {
  const regras = new Map<number, RegraRecorrencia>()
  const instancias: InstanciaRegistrada[] = []
  const falhas = new Set<number>()
  const claims = new Map<number, number>()
  // Mutex por regra: reproduz o lock de linha do FOR UPDATE.
  const cadeados = new Map<number, Promise<void>>()

  const adquirir = async (id: number): Promise<() => void> => {
    let liberar!: () => void
    const proximo = new Promise<void>((r) => {
      liberar = r
    })
    const espera = cadeados.get(id) ?? Promise.resolve()
    cadeados.set(
      id,
      espera.then(() => proximo),
    )
    await espera
    return liberar
  }

  const repo: RepositorioRecorrenciaAgendador = {
    listarRegrasVencidas: async (agora: Date): Promise<RegraVencidaResumo[]> =>
      [...regras.values()]
        .filter(
          (r) =>
            r.ativa &&
            (r.proximaGeracao === null ||
              parseDatetimeMysql(r.proximaGeracao).getTime() <= agora.getTime()),
        )
        .map((r) => ({ id: r.id, organizacaoId: r.organizacaoId })),

    emTransacao: async <T>(
      fn: (tx: TransacaoRecorrencia) => Promise<T>,
    ): Promise<T> => {
      // O fake não aninha transações por regra; o lock é adquirido no claim
      // e liberado no fim da transação. Como o service abre uma transação por
      // regra, a chave do mutex é definida no primeiro acesso.
      let idAtiva: number | null = null
      let liberar: (() => void) | null = null
      const garantirLock = async (id: number): Promise<void> => {
        if (idAtiva === id && liberar) return
        liberar = await adquirir(id)
        idAtiva = id
      }
      const tx: TransacaoRecorrencia = {
        claimRegra: async (id: number) => {
          await garantirLock(id)
          claims.set(id, (claims.get(id) ?? 0) + 1)
          const r = regras.get(id)
          return r ? { ...r } : null
        },
        inserirInstancia: async (instancia: InstanciaTarefa) => {
          if (idAtiva !== null && falhas.has(idAtiva)) {
            throw new Error("falha injetada na geração")
          }
          instancias.push({ regraId: idAtiva as number, instancia })
        },
        avancarProximaGeracao: async (id: number, proximaGeracao: string) => {
          const r = regras.get(id)
          if (r) r.proximaGeracao = proximaGeracao
        },
        encerrarRegra: async (id: number) => {
          const r = regras.get(id)
          if (r) {
            r.ativa = false
            r.proximaGeracao = null
          }
        },
      }
      try {
        return await fn(tx)
      } finally {
        // Cast: o narrowing do TS não vê a atribuição feita no closure.
        const sair = liberar as (() => void) | null
        if (sair) sair()
      }
    },
  }
  return { repo, regras, instancias, falhas, claims }
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

// ============================================================================
// Logger stub
// ============================================================================

interface LogStub {
  lines: { level: "error" | "log" | "debug"; message: string }[]
  error(message: string): void
  log(message: string): void
  debug(message: string): void
}
function logStub(): LogStub {
  const stub = {
    lines: [] as { level: "error" | "log" | "debug"; message: string }[],
    error(message: string) {
      stub.lines.push({ level: "error", message })
    },
    log(message: string) {
      stub.lines.push({ level: "log", message })
    },
    debug(message: string) {
      stub.lines.push({ level: "debug", message })
    },
  }
  return stub
}
function withLogger(service: RecorrenciaAgendadorService, stub: LogStub): void {
  ;(service as unknown as { logger: LogStub }).logger = stub
}

// ============================================================================
// Specs
// ============================================================================

describe("RecorrenciaAgendadorService", () => {
  beforeEach(() => {
    delete process.env.GESTAO_TAREFAS_RECORRENCIA_SCHEDULER
  })
  afterEach(() => {
    delete process.env.GESTAO_TAREFAS_RECORRENCIA_SCHEDULER
  })

  it("bootstrap: cursor NULL calcula proximaGeracao a partir de agora, sem gerar instância", async () => {
    const f = criarFake()
    f.regras.set(
      11,
      regra({ proximaGeracao: null, horaDoDia: "09:00:00", dataInicio: "2026-12-01" }),
    )
    const agora = new Date("2026-12-05T08:00:00")
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => agora,
    })
    await service.tick()
    expect(f.instancias).toHaveLength(0)
    // Próxima ocorrência estritamente posterior a agora: 05/12 09:00.
    expect(f.regras.get(11)!.proximaGeracao).toBe("2026-12-05 09:00:00")
  })

  it("regra vencida gera exatamente 1 instância com vínculo e área/responsável/título copiados", async () => {
    const f = criarFake()
    f.regras.set(
      11,
      regra({
        proximaGeracao: "2026-12-05 09:00:00",
        horaDoDia: "09:00:00",
        titulo: "Rotina diária",
      }),
    )
    const agora = new Date("2026-12-05T09:00:30")
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => agora,
    })
    await service.tick()
    expect(f.instancias).toHaveLength(1)
    const { regraId, instancia } = f.instancias[0]!
    expect(regraId).toBe(11)
    expect(instancia.regraRecorrenciaId).toBe(11)
    expect(instancia.titulo).toBe("Rotina diária")
    expect(instancia.areaId).toBe(5)
    expect(instancia.responsavelId).toBe(7)
    expect(instancia.organizacaoId).toBe(3)
    expect(instancia.status).toBe("aberta")
    expect(instancia.prazo).toBeNull()
    // Cursor avança a partir da ocorrência gerada (próximo dia às 09:00).
    expect(f.regras.get(11)!.proximaGeracao).toBe("2026-12-06 09:00:00")
  })

  it("segunda execução com o mesmo cursor não duplica (claim: leitura vê cursor avançado)", async () => {
    const f = criarFake()
    f.regras.set(
      11,
      regra({ proximaGeracao: "2026-12-05 09:00:00", horaDoDia: "09:00:00" }),
    )
    const agora = new Date("2026-12-05T09:00:30")
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => agora,
    })
    await service.tick()
    // "Restart": outro tick no mesmo instante — cursor já avançou, nada gera.
    await service.tick()
    expect(f.instancias).toHaveLength(1)
  })

  it("duas execuções CONCorrentes sobre a mesma regra geram 1 instância (FOR UPDATE fake)", async () => {
    const f = criarFake()
    f.regras.set(
      11,
      regra({ proximaGeracao: "2026-12-05 09:00:00", horaDoDia: "09:00:00" }),
    )
    const agora = new Date("2026-12-05T09:00:30")
    // Dois agendadores (dual blue-green), cada um com sua instância de service
    // sobre o MESMO fake (mesma tabela).
    const a = new RecorrenciaAgendadorService(f.repo, { intervalMs: 999_999, now: () => agora })
    const b = new RecorrenciaAgendadorService(f.repo, { intervalMs: 999_999, now: () => agora })
    await Promise.all([a.tick(), b.tick()])
    expect(f.instancias).toHaveLength(1)
    expect(f.regras.get(11)!.proximaGeracao).toBe("2026-12-06 09:00:00")
  })

  it("guarda running: tick concorrente não sobrepõe varredura", async () => {
    let liberarListar: () => void = () => undefined
    const bloqueio = new Promise<void>((r) => {
      liberarListar = r
    })
    const f = criarFake()
    const original = f.repo.listarRegrasVencidas.bind(f.repo)
    let chamadas = 0
    f.repo.listarRegrasVencidas = async (agora: Date) => {
      chamadas += 1
      if (chamadas === 1) await bloqueio
      return original(agora)
    }
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T09:00:30"),
    })
    const primeiro = service.tick()
    await service.tick() // deve retornar imediatamente (running=true)
    expect(chamadas).toBe(1)
    liberarListar()
    await primeiro
    await service.tick()
    expect(chamadas).toBe(2)
  })

  it("regra semanal: gera no tick com cursor vencido; sem cursor vencido não gera (dias via subtarefa 1)", async () => {
    const f = criarFake()
    // Seg/Qua/Sex (1,3,5) às 08:00; cursor na próxima quarta.
    f.regras.set(
      21,
      regra({
        id: 21,
        frequencia: "semanal",
        diasSemana: [1, 3, 5],
        horaDoDia: "08:00:00",
        proximaGeracao: "2026-12-09 08:00:00",
      }),
    )
    const serviceAntes = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      // terça 08/12 — cursor (09/12) ainda não venceu.
      now: () => new Date("2026-12-08T23:00:00"),
    })
    await serviceAntes.tick()
    expect(f.instancias).toHaveLength(0)

    const serviceDepois = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-09T08:00:10"),
    })
    await serviceDepois.tick()
    expect(f.instancias).toHaveLength(1)
    // Próximo dia selecionado após qua 09/12: sex 11/12 08:00 (pula qui).
    expect(f.regras.get(21)!.proximaGeracao).toBe("2026-12-11 08:00:00")
  })

  it("regra mensal: gera 1 instância no ciclo e avança para o mês seguinte", async () => {
    const f = criarFake()
    f.regras.set(
      31,
      regra({
        id: 31,
        frequencia: "mensal",
        dataInicio: "2026-11-15",
        horaDoDia: "10:00:00",
        proximaGeracao: "2026-12-15 10:00:00",
      }),
    )
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-15T10:05:00"),
    })
    await service.tick()
    expect(f.instancias).toHaveLength(1)
    expect(f.regras.get(31)!.proximaGeracao).toBe("2027-01-15 10:00:00")
  })

  it("dataFim alcançado: última ocorrência dentro do limite gera, regra vira ativa=false e nada mais gera", async () => {
    const f = criarFake()
    f.regras.set(
      41,
      regra({
        id: 41,
        horaDoDia: "09:00:00",
        dataFim: "2026-12-07",
        proximaGeracao: "2026-12-06 09:00:00",
      }),
    )
    const s1 = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-06T09:00:30"),
    })
    await s1.tick()
    expect(f.instancias).toHaveLength(1)
    // Próxima ocorrência (07/12) ainda dentro do dataFim.
    expect(f.regras.get(41)!.proximaGeracao).toBe("2026-12-07 09:00:00")

    const s2 = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-07T09:00:30"),
    })
    await s2.tick()
    expect(f.instancias).toHaveLength(2)
    // Último ciclo encerrado: regra desativada, cursor NULL.
    expect(f.regras.get(41)!.ativa).toBe(false)
    expect(f.regras.get(41)!.proximaGeracao).toBeNull()

    // Tick seguinte não gera mais nada.
    const s3 = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-08T09:00:30"),
    })
    await s3.tick()
    expect(f.instancias).toHaveLength(2)
  })

  it("dataFim editado para trás: cursor vencido após o fim encerra sem gerar instância", async () => {
    const f = criarFake()
    f.regras.set(
      51,
      regra({
        id: 51,
        proximaGeracao: "2026-12-10 09:00:00",
        dataFim: "2026-12-05", // encurtado depois do cursor calculado
      }),
    )
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-11T10:00:00"),
    })
    await service.tick()
    expect(f.instancias).toHaveLength(0)
    expect(f.regras.get(51)!.ativa).toBe(false)
  })

  it("regra desativada (ativa=false) não gera; instâncias passadas permanecem intocadas", async () => {
    const f = criarFake()
    f.regras.set(
      61,
      regra({ id: 61, ativa: false, proximaGeracao: "2026-12-05 09:00:00" }),
    )
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T09:30:00"),
    })
    await service.tick()
    expect(f.instancias).toHaveLength(0)
    expect(f.claims.get(61)).toBeUndefined() // nem claimada: fora da varredura
  })

  it("erro em uma regra: Logger.error estruturado, cursor não avança e demais regras continuam", async () => {
    const f = criarFake()
    f.regras.set(
      71,
      regra({ id: 71, proximaGeracao: "2026-12-05 09:00:00", horaDoDia: "09:00:00" }),
    )
    f.regras.set(
      72,
      regra({
        id: 72,
        organizacaoId: 9,
        titulo: "Outra regra",
        proximaGeracao: "2026-12-05 09:00:00",
        horaDoDia: "09:00:00",
      }),
    )
    f.falhas.add(71)
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T09:00:30"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()

    // A sã gerou; a falha não.
    expect(f.instancias.map((i) => i.instancia.titulo)).toEqual(["Outra regra"])
    expect(f.regras.get(71)!.proximaGeracao).toBe("2026-12-05 09:00:00") // não avançou
    expect(f.regras.get(72)!.proximaGeracao).toBe("2026-12-06 09:00:00")

    const erros = logs.lines.filter((l) => l.level === "error")
    expect(erros).toHaveLength(1)
    const payload = JSON.parse(erros[0]!.message)
    expect(payload).toMatchObject({
      evento: "recorrencia_geracao_falhou",
      organizacaoId: 3,
      regraId: 71,
    })
    expect(payload.motivo).toContain("falha injetada")
  })

  it("falha do claim de uma regra não interrompe as demais do tick", async () => {
    const f = criarFake()
    f.regras.set(
      81,
      regra({ id: 81, proximaGeracao: "2026-12-05 09:00:00", horaDoDia: "09:00:00" }),
    )
    f.regras.set(
      82,
      regra({ id: 82, titulo: "Sobrevivente", proximaGeracao: "2026-12-05 09:00:00", horaDoDia: "09:00:00" }),
    )
    const emTransacaoOriginal = f.repo.emTransacao.bind(f.repo)
    f.repo.emTransacao = ((fn: (tx: TransacaoRecorrencia) => Promise<unknown>) =>
      emTransacaoOriginal(async (tx) => {
        // Simula pane no SELECT ... FOR UPDATE apenas para a regra 81.
        const claimOriginal = tx.claimRegra.bind(tx)
        return fn({
          ...tx,
          claimRegra: async (id: number) => {
            if (id === 81) throw new Error("boom no lock da regra 81")
            return claimOriginal(id)
          },
        })
      })) as RepositorioRecorrenciaAgendador["emTransacao"]
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T09:00:30"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()
    // A regra sã gerou apesar da pane na outra; a falha foi registrada.
    expect(f.instancias.map((i) => i.instancia.titulo)).toEqual(["Sobrevivente"])
    expect(f.regras.get(81)!.proximaGeracao).toBe("2026-12-05 09:00:00")
    expect(logs.lines.filter((l) => l.level === "error")).toHaveLength(1)
  })

  it("falha da varredura (banco fora) é registrada e o tick seguinte tenta de novo", async () => {
    const f = criarFake()
    f.regras.set(
      91,
      regra({ id: 91, proximaGeracao: "2026-12-05 09:00:00" }),
    )
    const listarOriginal = f.repo.listarRegrasVencidas.bind(f.repo)
    let cai = true
    f.repo.listarRegrasVencidas = async (agora: Date) => {
      if (cai) {
        cai = false
        throw new Error("connect ECONNREFUSED")
      }
      return listarOriginal(agora)
    }
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T09:00:30"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()
    expect(f.instancias).toHaveLength(0)
    expect(logs.lines.some((l) => l.message.includes("recorrencia_varredura_falhou"))).toBe(true)
    await service.tick()
    expect(f.instancias).toHaveLength(1)
  })

  it("onModuleInit agenda com timer unref; onModuleDestroy limpa (processo não pendura)", () => {
    const f = criarFake()
    const service = new RecorrenciaAgendadorService(f.repo, { intervalMs: 60_000 })
    service.onModuleInit()
    const timer = (service as unknown as { timer: NodeJS.Timeout | null }).timer
    expect(timer).not.toBeNull()
    // unref(): o handle não segura o event loop (retorno `this` em Node ≥ 10).
    expect(timer!.hasRef()).toBe(false)
    service.onModuleDestroy()
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull()
    expect(() => service.onModuleDestroy()).not.toThrow()
  })

  it("GESTAO_TAREFAS_RECORRENCIA_SCHEDULER=0 desliga o agendador", () => {
    process.env.GESTAO_TAREFAS_RECORRENCIA_SCHEDULER = "0"
    const f = criarFake()
    const listar = vi.fn(f.repo.listarRegrasVencidas.bind(f.repo))
    f.repo.listarRegrasVencidas = listar
    const service = new RecorrenciaAgendadorService(f.repo, { intervalMs: 60_000 })
    service.onModuleInit()
    expect(listar).not.toHaveBeenCalled()
    expect((service as unknown as { timer: unknown }).timer).toBeNull()
    expect(() => service.onModuleDestroy()).not.toThrow()
  })

  it("options.enabled=false sobrepõe o default e não agenda", () => {
    const f = criarFake()
    const service = new RecorrenciaAgendadorService(f.repo, {
      intervalMs: 60_000,
      enabled: false,
    })
    service.onModuleInit()
    expect((service as unknown as { timer: unknown }).timer).toBeNull()
  })

  it("datetime-mysql: round-trip do cursor no formato de coluna", () => {
    const d = new Date(2026, 11, 5, 9, 0, 30)
    const texto = formatarDatetimeMysql(d)
    expect(texto).toBe("2026-12-05 09:00:30")
    expect(parseDatetimeMysql(texto).getTime()).toBe(d.getTime())
    expect(parseDatetimeMysql("2026-12-05T09:00:30").getTime()).toBe(d.getTime())
    expect(parseDatetimeMysql(d).getTime()).toBe(d.getTime())
  })
})
