// @vitest-environment node
/**
 * Testes unitários do LembreteAgendadorService (macro 5, subtarefa 1) —
 * repo/transactions fake + `now()` injetado (padrão dos specs de fluxo do
 * projeto e do agendador de recorrência, macro 4; sem MySQL).
 *
 * O fake reproduz a semântica do claim `SELECT ... FOR UPDATE` com um mutex
 * assíncrono POR TAREFA: a transação que claima primeiro bloqueia as demais
 * até o commit; a segunda leitura do concorrente vê o marcador
 * `lembrete_gerado` já inserido e não duplica — é exatamente o
 * comportamento do FOR UPDATE + lock de linha que dá idempotência sob
 * restart/dual blue-green.
 *
 * Cobre o aceite:
 * - tarefa com antecedência 60min e prazo futuro: 1 notificação
 *   tipo='lembrete' para o `usuarioId` do responsável + histórico
 *   'lembrete_gerado' na mesma transação;
 * - antecedência NULL ou prazo NULL: nunca selecionada/notificada;
 * - idempotência: segundo tick e concorrência (dual blue-green) não
 *   duplicam notificação;
 * - pós-disparo: antecedência ampliada NÃO re-notifica (v1 = 1 lembrete);
 * - janela fechada (prazo já venceu): não dispara;
 * - responsável sem usuario_id: falha isolada registrada (Logger.error
 *   JSON) e demais tarefas do tick continuam;
 * - timer unref + clearInterval no onModuleDestroy; flag env desliga.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LembreteAgendadorService } from "../lembrete-agendador.service"
import type {
  RepositorioLembreteAgendador,
  TarefaLembreteCandidata,
  TransacaoLembrete,
} from "../lembrete-agendador.repositorio"
import {
  formatarDatetimeMysql,
  parseDatetimeMysql,
} from "../datetime-mysql"

// ============================================================================
// Fake do repositório (mutex por tarefa = SELECT ... FOR UPDATE)
// ============================================================================

interface TarefaFake {
  id: number
  organizacaoId: number
  titulo: string
  responsavelId: number
  prazo: string | null
  antecedenciaMinutos: number | null
}

interface ColaboradorFake {
  id: number
  usuarioId: number | null
}

interface NotificacaoFake {
  organizacaoId: number
  usuarioId: number
  titulo: string
  corpo: string | null
  tipo: string
  tarefaId: number
  lida: boolean
}

interface HistoricoFake {
  tarefaId: number
  tipoEvento: string
  mensagem: string
}

interface FakeApi {
  repo: RepositorioLembreteAgendador
  tarefas: Map<number, TarefaFake>
  colaboradores: Map<number, ColaboradorFake>
  notificacoes: NotificacaoFake[]
  historico: HistoricoFake[]
  /** ids das tarefas cuja transação falha (erro injetado). */
  falhas: Set<number>
  /** Contagem de claims (leitura FOR UPDATE) por tarefa. */
  claims: Map<number, number>
}

function criarFake(): FakeApi {
  const tarefas = new Map<number, TarefaFake>()
  const colaboradores = new Map<number, ColaboradorFake>()
  const notificacoes: NotificacaoFake[] = []
  const historico: HistoricoFake[] = []
  const falhas = new Set<number>()
  const claims = new Map<number, number>()
  // Mutex por tarefa: reproduz o lock de linha do FOR UPDATE.
  const cadeados = new Map<number, Promise<void>>()

  const adquirir = async (id: number): Promise<() => void> => {
    let liberar!: () => void
    const proximo = new Promise<void>((r) => {
      liberar = r
    })
    const espera = cadeados.get(id) ?? Promise.resolve()
    cadeados.set(id, espera.then(() => proximo))
    await espera
    return liberar
  }

  const repo: RepositorioLembreteAgendador = {
    listarTarefasCandidatas: async (
      agora: Date,
    ): Promise<TarefaLembreteCandidata[]> =>
      [...tarefas.values()]
        .filter(
          (t) =>
            t.prazo !== null &&
            t.antecedenciaMinutos !== null &&
            parseDatetimeMysql(t.prazo).getTime() > agora.getTime(),
        )
        .map((t) => ({
          id: t.id,
          organizacaoId: t.organizacaoId,
          prazo: t.prazo as string,
          antecedenciaMinutos: t.antecedenciaMinutos as number,
        })),

    emTransacao: async <T>(
      fn: (tx: TransacaoLembrete) => Promise<T>,
    ): Promise<T> => {
      // O fake não aninha transações por tarefa; o lock é adquirido no claim
      // e liberado no fim da transação. Como o service abre uma transação por
      // tarefa, a chave do mutex é definida no primeiro acesso.
      let idAtiva: number | null = null
      let liberar: (() => void) | null = null
      const garantirLock = async (id: number): Promise<void> => {
        if (idAtiva === id && liberar) return
        liberar = await adquirir(id)
        idAtiva = id
      }
      const tx: TransacaoLembrete = {
        claimTarefa: async (id: number) => {
          await garantirLock(id)
          claims.set(id, (claims.get(id) ?? 0) + 1)
          const t = tarefas.get(id)
          return t ? { ...t } : null
        },
        hasLembreteGerado: async (tarefaId: number) =>
          historico.some(
            (h) =>
              h.tarefaId === tarefaId && h.tipoEvento === "lembrete_gerado",
          ),
        resolveUsuarioResponsavel: async (responsavelId: number) => {
          const c = colaboradores.get(responsavelId)
          return c ? c.usuarioId : null
        },
        inserirNotificacao: async (n) => {
          if (idAtiva !== null && falhas.has(idAtiva)) {
            throw new Error("falha injetada no disparo")
          }
          notificacoes.push({
            ...n,
            tipo: "lembrete",
            lida: false,
          })
        },
        registrarHistoricoLembreteGerado: async (tarefaId, mensagem) => {
          if (idAtiva !== null && falhas.has(idAtiva)) {
            throw new Error("falha injetada no histórico")
          }
          historico.push({
            tarefaId,
            tipoEvento: "lembrete_gerado",
            mensagem,
          })
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
  return { repo, tarefas, colaboradores, notificacoes, historico, falhas, claims }
}

function tarefa(overrides: Partial<TarefaFake> = {}): TarefaFake {
  return {
    id: 101,
    organizacaoId: 3,
    titulo: "Fechar relatório mensal",
    responsavelId: 7,
    prazo: "2026-12-05 14:00:00",
    antecedenciaMinutos: 60,
    ...overrides,
  }
}

function withUsuario(fake: FakeApi, colaboradorId: number, usuarioId: number | null): void {
  fake.colaboradores.set(colaboradorId, { id: colaboradorId, usuarioId })
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
function withLogger(service: LembreteAgendadorService, stub: LogStub): void {
  ;(service as unknown as { logger: LogStub }).logger = stub
}

// ============================================================================
// Specs
// ============================================================================

describe("LembreteAgendadorService", () => {
  beforeEach(() => {
    delete process.env.GESTAO_TAREFAS_LEMBRETE_SCHEDULER
  })
  afterEach(() => {
    delete process.env.GESTAO_TAREFAS_LEMBRETE_SCHEDULER
  })

  it("tarefa com antecedência 60min e prazo futuro: 1 notificação tipo='lembrete' + histórico 'lembrete_gerado' na mesma transação", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    // agora = 13:00 = prazo - 60min (janela aberta).
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await service.tick()

    expect(f.notificacoes).toHaveLength(1)
    const n = f.notificacoes[0]!
    expect(n.tipo).toBe("lembrete")
    expect(n.lida).toBe(false)
    expect(n.tarefaId).toBe(101)
    expect(n.organizacaoId).toBe(3)
    expect(n.usuarioId).toBe(42) // do responsável via colaboradores.usuario_id
    expect(n.titulo).toBe("Lembrete: Fechar relatório mensal")
    expect(n.corpo).toContain("2026-12-05 14:00:00")
    expect(f.historico).toHaveLength(1)
    expect(f.historico[0]!.tipoEvento).toBe("lembrete_gerado")
    expect(f.historico[0]!.tarefaId).toBe(101)
  })

  it("antes da janela (agora < prazo-60min): não dispara", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T12:59:59"),
    })
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
    expect(f.claims.has(101)).toBe(false) // nem entra em transação
  })

  it("prazo vencido (agora >= prazo): janela fechada — não dispara", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    // Varredura já exclui (prazo > agora falha); mesmo assim o service
    // re-valida sob lock — cobrindo os dois níveis de guarda.
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T14:00:00"),
    })
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
  })

  it("tarefa com antecedência NULL nunca é selecionada nem notifica (default sem aviso)", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa({ antecedenciaMinutos: null }))
    withUsuario(f, 7, 42)
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
  })

  it("tarefa com prazo NULL nunca é selecionada nem notifica (sem prazo → sem lembrete)", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa({ prazo: null }))
    withUsuario(f, 7, 42)
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
  })

  it("guarda sob lock: prazo apagado entre varredura e claim → não dispara (rollback limpo)", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    const listarOriginal = f.repo.listarTarefasCandidatas.bind(f.repo)
    f.repo.listarTarefasCandidatas = async (agora) =>
      listarOriginal(agora)
    // Varredura manual com o estado anterior (candidata)...
    const candidatas = await listarOriginal(new Date("2026-12-05T13:00:00"))
    expect(candidatas).toHaveLength(1)
    // ...simula edição: prazo removido ENTRE varredura e claim (o lock seria
    // concedido após o UPDATE commitar).
    f.tarefas.set(101, tarefa({ prazo: null }))
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
  })

  it("segundo tick no mesmo instante não duplica (marcador histórico 'lembrete_gerado')", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await service.tick()
    await service.tick() // "restart"/tick seguinte: janela ainda aberta
    expect(f.notificacoes).toHaveLength(1)
    expect(f.historico).toHaveLength(1)
  })

  it("dois agendadores CONCORRENTES (dual blue-green) sobre a mesma tabela geram 1 notificação", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    const a = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    const b = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await Promise.all([a.tick(), b.tick()])
    expect(f.notificacoes).toHaveLength(1)
    expect(f.historico).toHaveLength(1)
  })

  it("pós-disparo: antecedência ampliada NÃO re-notifica (v1 = 1 lembrete por tarefa)", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa({ antecedenciaMinutos: 60 }))
    withUsuario(f, 7, 42)
    const s1 = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    await s1.tick()
    expect(f.notificacoes).toHaveLength(1)

    // Usuário aumenta a antecedência para 120min no mesmo dia: sem
    // re-notificação — o marcador 'lembrete_gerado' já existe.
    f.tarefas.set(
      101,
      tarefa({ antecedenciaMinutos: 120, prazo: "2026-12-05 16:00:00" }),
    )
    const s2 = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T14:00:00"),
    })
    await s2.tick()
    expect(f.notificacoes).toHaveLength(1)
  })

  it("responsável sem usuario_id vinculado: falha isolada registrada; demais tarefas do tick continuam", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa({ id: 101, titulo: "Sem usuário" }))
    f.tarefas.set(102, tarefa({ id: 102, titulo: "Sobrevivente" }))
    withUsuario(f, 7, null) // responsável 7 sem vínculo
    withUsuario(f, 8, 99) // responsável 8 vinculado
    f.tarefas.set(102, tarefa({ id: 102, titulo: "Sobrevivente", responsavelId: 8 }))
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()

    expect(f.notificacoes).toHaveLength(1)
    expect(f.notificacoes[0]!.tarefaId).toBe(102)
    expect(f.notificacoes[0]!.usuarioId).toBe(99)

    const erros = logs.lines.filter((l) => l.level === "error")
    expect(erros).toHaveLength(1)
    const payload = JSON.parse(erros[0]!.message)
    expect(payload).toMatchObject({
      evento: "lembrete_disparo_falhou",
      organizacaoId: 3,
      tarefaId: 101,
    })
    expect(payload.motivo).toContain("usuario_id")
    // Nada foi gravado para a tarefa que falhou (rollback: marcador e
    // notificação juntos) → retry natural no próximo tick.
    expect(f.historico.filter((h) => h.tarefaId === 101)).toHaveLength(0)
  })

  it("falha injetada no insert de UMA tarefa: Logger.error JSON e as demais continuam (padrão 'eventos de erro registrados')", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa({ id: 101, titulo: "Quebra" }))
    f.tarefas.set(102, tarefa({ id: 102, titulo: "Sobrevivente" }))
    withUsuario(f, 7, 42)
    f.falhas.add(101)
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()

    expect(f.notificacoes.map((n) => n.tarefaId)).toEqual([102])
    expect(logs.lines.filter((l) => l.level === "error")).toHaveLength(1)
    const payload = JSON.parse(logs.lines.find((l) => l.level === "error")!.message)
    expect(payload.evento).toBe("lembrete_disparo_falhou")
    expect(payload.tarefaId).toBe(101)
    expect(payload.motivo).toContain("falha injetada")
  })

  it("falha da varredura (banco fora) é registrada e o tick seguinte tenta de novo", async () => {
    const f = criarFake()
    f.tarefas.set(101, tarefa())
    withUsuario(f, 7, 42)
    const listarOriginal = f.repo.listarTarefasCandidatas.bind(f.repo)
    let cai = true
    f.repo.listarTarefasCandidatas = async (agora) => {
      if (cai) {
        cai = false
        throw new Error("connect ECONNREFUSED")
      }
      return listarOriginal(agora)
    }
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    const logs = logStub()
    withLogger(service, logs)
    await service.tick()
    expect(f.notificacoes).toHaveLength(0)
    expect(
      logs.lines.some((l) => l.message.includes("lembrete_varredura_falhou")),
    ).toBe(true)
    await service.tick()
    expect(f.notificacoes).toHaveLength(1)
  })

  it("guarda running: tick concorrente não sobrepõe varredura", async () => {
    let liberarListar: () => void = () => undefined
    const bloqueio = new Promise<void>((r) => {
      liberarListar = r
    })
    const f = criarFake()
    const original = f.repo.listarTarefasCandidatas.bind(f.repo)
    let chamadas = 0
    f.repo.listarTarefasCandidatas = async (agora) => {
      chamadas += 1
      if (chamadas === 1) await bloqueio
      return original(agora)
    }
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 999_999,
      now: () => new Date("2026-12-05T13:00:00"),
    })
    const primeiro = service.tick()
    await service.tick() // deve retornar imediatamente (running=true)
    expect(chamadas).toBe(1)
    liberarListar()
    await primeiro
    await service.tick()
    expect(chamadas).toBe(2)
  })

  it("onModuleInit agenda com timer unref; onModuleDestroy limpa (processo não pendura)", () => {
    const f = criarFake()
    const service = new LembreteAgendadorService(f.repo, { intervalMs: 60_000 })
    service.onModuleInit()
    const timer = (service as unknown as { timer: NodeJS.Timeout | null }).timer
    expect(timer).not.toBeNull()
    // unref(): o handle não segura o event loop (retorno `this` em Node ≥ 10).
    expect(timer!.hasRef()).toBe(false)
    service.onModuleDestroy()
    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull()
    expect(() => service.onModuleDestroy()).not.toThrow()
  })

  it("GESTAO_TAREFAS_LEMBRETE_SCHEDULER=0 desliga o agendador", () => {
    process.env.GESTAO_TAREFAS_LEMBRETE_SCHEDULER = "0"
    const f = criarFake()
    const listar = vi.fn(f.repo.listarTarefasCandidatas.bind(f.repo))
    f.repo.listarTarefasCandidatas = listar
    const service = new LembreteAgendadorService(f.repo, { intervalMs: 60_000 })
    service.onModuleInit()
    expect(listar).not.toHaveBeenCalled()
    expect((service as unknown as { timer: unknown }).timer).toBeNull()
    expect(() => service.onModuleDestroy()).not.toThrow()
  })

  it("options.enabled=false sobrepõe o default e não agenda", () => {
    const f = criarFake()
    const service = new LembreteAgendadorService(f.repo, {
      intervalMs: 60_000,
      enabled: false,
    })
    service.onModuleInit()
    expect((service as unknown as { timer: unknown }).timer).toBeNull()
  })

  it("datetime-mysql: round-trip do prazo no formato de coluna", () => {
    const d = new Date(2026, 11, 5, 14, 0, 0)
    const texto = formatarDatetimeMysql(d)
    expect(texto).toBe("2026-12-05 14:00:00")
    expect(parseDatetimeMysql(texto).getTime()).toBe(d.getTime())
    expect(parseDatetimeMysql("2026-12-05T14:00:00").getTime()).toBe(d.getTime())
    expect(parseDatetimeMysql(d).getTime()).toBe(d.getTime())
  })
})
