// @vitest-environment jsdom
/**
 * Testes da camada de dados/interações do Mapa de Agentes (subtarefa 1086).
 *
 * Cobre os critérios de aceite:
 * 1. mesmos contratos/mecanismos da tela legada (endpoints + query);
 * 2. polling, tempo real, reconexão, fechamento e limite de eventos;
 * 3. seleção carrega detalhe sem navegação;
 * 4. start/pause/resume mantêm habilitação e erros;
 * 5. fallback de subtarefas (motor vazio → banco).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import {
  OPERATION_EVENT_LIMIT,
  OPERATION_POLL_MS,
  applyTaskEvent,
  canPauseTask,
  canStartTask,
  limitRealtimeEvents,
  mergeChatMessages,
  resolveSelection,
  resolveSubtasks,
  useOperationMapData,
  type OperationMapChatMessage,
  type OperationMapDbSubtask,
  type OperationMapDetail,
  type OperationMapTask,
} from "../operationMapData"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

/** Fábrica de `RealtimeClient` controlável (a real exige WebSocket/ticket). */
const realtime = vi.hoisted(() => {
  interface OpcoesRealtime {
    taskId?: number
    onMessage?: (mensagem: unknown) => void
    onStatusChange?: (status: "connecting" | "open" | "closed") => void
  }
  class FakeRealtime {
    options: OpcoesRealtime
    conectado = 0
    fechado = 0
    constructor(options: OpcoesRealtime) {
      this.options = options
      fake.instances.push(this)
    }
    async connect() {
      this.conectado += 1
      this.options.onStatusChange?.("connecting")
      this.options.onStatusChange?.("open")
    }
    close() {
      this.fechado += 1
      this.options.onStatusChange?.("closed")
    }
    emitir(mensagem: unknown) {
      this.options.onMessage?.(mensagem)
    }
  }
  const fake = { instances: [] as FakeRealtime[], FakeRealtime }
  return fake
})

vi.mock("@biblioteca-global/api-client", () => ({ RealtimeClient: realtime.FakeRealtime }))

// ---------------------------------------------------------------- servidor fake

type Chamada = { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

interface CenarioFalso {
  tarefas?: OperationMapTask[]
  projetos?: Array<{ id: number; nome: string }>
  detalheDoMotor?: (id: number) => OperationMapDetail
  subtarefasDoBanco?: (id: number) => OperationMapDbSubtask[]
  chat?: (id: number) => OperationMapChatMessage[]
  atividade?: Record<string, unknown>
  deploy?: Record<string, unknown>
  falharAcao?: boolean
}

function tarefa(id: number, status: string, extra?: Partial<OperationMapTask>): OperationMapTask {
  return {
    id,
    titulo: `Tarefa ${id}`,
    status,
    projetoId: 1,
    createdAt: "2026-09-13T10:00:00Z",
    updatedAt: "2026-09-13T10:00:00Z",
    ...extra,
  }
}

function criarServidor(cenario: CenarioFalso = {}) {
  const chamadas: Chamada[] = []
  const http = {
    request: async (method: string, path: string, options?: { query?: Record<string, unknown>; body?: unknown }) => {
      chamadas.push({ method, path, query: options?.query, body: options?.body })
      if (method === "GET" && path === "/gerenteagentes/projetos_captados") {
        return { items: cenario.projetos ?? [{ id: 1, nome: "Global" }] }
      }
      if (method === "GET" && path === "/gerenteagentes/tarefas-com-status") {
        return cenario.tarefas ?? [tarefa(1, "running")]
      }
      if (method === "GET" && path === "/gerenteagentes/motor-activity") {
        return cenario.atividade ?? { activities: [{ taskId: "task-1", phase: "verify" }] }
      }
      if (method === "GET" && path === "/gerenteagentes/motor-deploy-diagnostics") {
        return cenario.deploy ?? { canStart: true, reasons: ["ok"], pendingRequests: 0 }
      }
      const motorDetail = /^\/gerenteagentes\/tarefas\/(\d+)\/motor-detail$/.exec(path)
      if (method === "GET" && motorDetail) {
        const id = Number(motorDetail[1])
        return cenario.detalheDoMotor?.(id) ?? { exists: true, task: { status: "running", title: `Tarefa ${id}` } }
      }
      const subtarefas = /^\/gerenteagentes\/tarefas\/(\d+)\/subtarefas$/.exec(path)
      if (method === "GET" && subtarefas) {
        return cenario.subtarefasDoBanco?.(Number(subtarefas[1])) ?? []
      }
      const chat = /^\/gerenteagentes\/tarefas\/(\d+)\/chat$/.exec(path)
      if (method === "GET" && chat) {
        return cenario.chat?.(Number(chat[1])) ?? []
      }
      if (method === "POST" && /\/gerenteagentes\/tarefas\/\d+\/(start|pause|resume|unlock)$/.test(path)) {
        if (cenario.falharAcao) throw new Error("Falha simulada na ação")
        return { ok: true }
      }
      if (method === "POST" && /\/gerenteagentes\/tarefas\/(pause-all|resume-all)$/.test(path)) {
        return { affected: 2 }
      }
      if (method === "POST" && chat) return { ok: true }
      return {}
    },
  }
  return { chamadas, bundle: { http, getAccessToken: () => "token-falso" } }
}

function usar(cenario: CenarioFalso = {}, options?: Parameters<typeof useOperationMapData>[0]) {
  const servidor = criarServidor(cenario)
  globalThis.__bundleFalso = servidor.bundle as never
  const view = renderHook(() => useOperationMapData(options))
  return { ...servidor, view }
}

const eventosDe = (view: { result: { current: { realtimeEvents: unknown[] } } }) => view.result.current.realtimeEvents

// ---------------------------------------------------------------- funções puras

describe("operationMapData — funções puras", () => {
  it("mescla o histórico do chat sem perder mensagem recebida em voo", () => {
    const historico: OperationMapChatMessage[] = [
      { id: 1, role: "user", texto: "oi", createdAt: "2026-09-13T10:00:00Z" },
      { id: 3, role: "assistant", texto: "olá", createdAt: "2026-09-13T10:00:02Z" },
    ]
    const atuais: OperationMapChatMessage[] = [
      { id: 2, role: "user", texto: "chegou no meio", createdAt: "2026-09-13T10:00:01Z" },
      { id: 3, role: "assistant", texto: "olá", createdAt: "2026-09-13T10:00:02Z" },
    ]
    const resultado = mergeChatMessages(historico, atuais)
    expect(resultado.map((m) => m.id)).toEqual([1, 2, 3])
  })

  it("respeita o limite do buffer de eventos mantendo os mais recentes", () => {
    const eventos = Array.from({ length: 8 }, (_, i) => ({ tipo: i }))
    const limitados = limitRealtimeEvents(eventos as never, 3)
    expect(limitados).toHaveLength(3)
    expect(limitados.map((e) => (e as { tipo: number }).tipo)).toEqual([5, 6, 7])
    expect(limitRealtimeEvents([], OPERATION_EVENT_LIMIT)).toHaveLength(0)
    expect(limitRealtimeEvents(eventos as never, 0)).toHaveLength(0)
  })

  it("mantém a seleção atual e, sem ela, prioriza tarefa não final e não rascunho", () => {
    const lista = [tarefa(1, "completed"), tarefa(2, "draft"), tarefa(3, "running")]
    expect(resolveSelection(lista, 1)).toBe(1)
    expect(resolveSelection(lista, "")).toBe(3)
    expect(resolveSelection([tarefa(9, "draft")], "")).toBe(9)
    expect(resolveSelection([], "")).toBe("")
  })

  it("aplica eventos de tarefa (created/updated/status/deleted) sem regra nova", () => {
    const base = [tarefa(1, "running"), tarefa(2, "draft")]

    const criado = applyTaskEvent(base, "task.created", { id: 3, titulo: "Nova", status: "planned", projetoId: 1 }, 3)
    expect(criado.map((t) => t.id)).toContain(3)

    const statusAlterado = applyTaskEvent(base, "task.status.changed", { status: "blocked" }, 1)
    expect(statusAlterado.find((t) => t.id === 1)?.status).toBe("blocked")

    const atualizado = applyTaskEvent(base, "task.updated", { id: 2, titulo: "Editada", status: "planned", projetoId: 1 }, 2)
    const t2 = atualizado.find((t) => t.id === 2)
    expect(t2?.titulo).toBe("Editada")
    expect(t2?.status).toBe("planned")

    expect(applyTaskEvent(base, "task.deleted", {}, 1).map((t) => t.id)).toEqual([2])
    expect(applyTaskEvent(base, "outro.evento", {}, 1)).toBe(base)
  })

  it("usa as subtarefas do motor e cai para o banco quando o motor não trouxe nenhuma", () => {
    const comMotor = resolveSubtasks(
      { exists: true, subtasks: [{ seq: 1, title: "Do motor", status: "verified" }] },
      [],
    )
    expect(comMotor.source).toBe("motor")
    expect(comMotor.subtasks[0]?.title).toBe("Do motor")

    const doBanco = resolveSubtasks({ exists: true, subtasks: [] }, [
      { id: 10, seq: 2, titulo: "Do banco", status: "delivered" },
    ])
    expect(doBanco.source).toBe("db")
    expect(doBanco.subtasks[0]?.title).toBe("Do banco")
    expect(doBanco.subtasks[0]?.deliverCount).toBe(0)
    expect(doBanco.subtasks[0]?.blockInfo).toBeNull()
    expect(doBanco.subtasks[0]?.deliveryHistory).toEqual([])

    expect(resolveSubtasks(null, []).source).toBe("none")
  })

  it("mantém as regras de habilitação das ações start/pause", () => {
    expect(canStartTask("paused")).toBe(true)
    expect(canStartTask("planned")).toBe(true)
    expect(canStartTask("running")).toBe(false)
    expect(canPauseTask("running")).toBe(true)
    expect(canPauseTask("analyzing")).toBe(true)
    expect(canPauseTask("draft")).toBe(false)
  })
})

// ---------------------------------------------------------------- hook

describe("useOperationMapData — leituras e interações", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    realtime.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.__bundleFalso
  })

  it("lê projetos, tarefas, atividade, detalhe e subtarefas com os mesmos contratos", async () => {
    const { chamadas, view } = usar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" } }),
      subtarefasDoBanco: () => [{ id: 5, seq: 1, titulo: "Sub", status: "pending" }],
    })

    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1))

    const caminhos = chamadas.map((c) => `${c.method} ${c.path}`)
    expect(caminhos).toContain("GET /gerenteagentes/projetos_captados")
    expect(caminhos).toContain("GET /gerenteagentes/tarefas-com-status")
    expect(caminhos).toContain("GET /gerenteagentes/motor-activity")
    expect(caminhos).toContain("GET /gerenteagentes/motor-deploy-diagnostics")

    // A seleção inicial dispara as leituras da tarefa, sem navegação.
    await waitFor(() => expect(caminhos).toContain("GET /gerenteagentes/tarefas/1/motor-detail"))
    expect(caminhos).toContain("GET /gerenteagentes/tarefas/1/subtarefas")
    expect(caminhos).toContain("GET /gerenteagentes/tarefas/1/chat")

    const listagem = chamadas.find((c) => c.path === "/gerenteagentes/tarefas-com-status")
    expect(listagem?.query).toEqual({ pageSize: 100 })
    expect(view.result.current.ready).toBe(true)
    expect(view.result.current.diagnostics?.canStart).toBe(true)
  })

  it("seleciona outra tarefa e recarrega o detalhe dela sem navegar de página", async () => {
    const { chamadas, view } = usar({
      tarefas: [tarefa(1, "running"), tarefa(2, "planned")],
      detalheDoMotor: (id) => ({ exists: true, task: { status: "running", title: `Tarefa ${id}` } }),
    })

    await waitFor(() => expect(view.result.current.tasks).toHaveLength(2))
    await waitFor(() => expect(view.result.current.selectedId).toBe(1))

    act(() => view.result.current.select(2))
    await waitFor(() => expect(view.result.current.selectedId).toBe(2))
    await waitFor(() =>
      expect(chamadas.some((c) => c.path === "/gerenteagentes/tarefas/2/motor-detail")).toBe(true),
    )
    expect(view.result.current.selected?.id).toBe(2)
  })

  it("reconcilia por polling a cada 5 s (lista, atividade e tarefa selecionada)", async () => {
    const { chamadas, view } = usar({ tarefas: [tarefa(1, "running")] })

    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1))
    const contar = (path: string) => chamadas.filter((c) => c.path === path).length
    const antesTarefas = contar("/gerenteagentes/tarefas-com-status")
    const antesDetalhe = contar("/gerenteagentes/tarefas/1/motor-detail")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPERATION_POLL_MS + 50)
    })

    expect(contar("/gerenteagentes/tarefas-com-status")).toBeGreaterThan(antesTarefas)
    expect(contar("/gerenteagentes/tarefas/1/motor-detail")).toBeGreaterThan(antesDetalhe)
    expect(contar("/gerenteagentes/motor-activity")).toBeGreaterThan(1)
  })

  it("expõe as subtarefas do banco quando o motor-detail vem sem subtarefas (fallback)", async () => {
    const { view } = usar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" }, subtasks: [] }),
      subtarefasDoBanco: () => [
        { id: 7, seq: 1, titulo: "Fallback do banco", status: "delivered", scope: "escopo" },
      ],
    })

    await waitFor(() => expect(view.result.current.subtaskSource).toBe("db"))
    expect(view.result.current.subtasks[0]?.title).toBe("Fallback do banco")
  })

  it("executa start/pause/resume nas mesmas rotas e propaga o erro da ação", async () => {
    const { chamadas, view } = usar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" } }),
    })

    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1))

    await act(async () => {
      await view.result.current.execute("pause")
    })
    expect(chamadas.some((c) => c.method === "POST" && c.path === "/gerenteagentes/tarefas/1/pause")).toBe(true)
    expect(view.result.current.error).toBeNull()

    await act(async () => {
      await view.result.current.execute("resume")
      await view.result.current.execute("start")
    })
    const posts = chamadas.filter((c) => c.method === "POST").map((c) => c.path)
    expect(posts).toContain("/gerenteagentes/tarefas/1/resume")
    expect(posts).toContain("/gerenteagentes/tarefas/1/start")
  })

  it("propaga o erro da ação sem derrubar a tela", async () => {
    const { view } = usar({ tarefas: [tarefa(1, "running")], falharAcao: true })

    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1))

    await act(async () => {
      await view.result.current.execute("start")
    })

    expect(view.result.current.error).toBe("Falha simulada na ação")
    act(() => view.result.current.clearError())
    expect(view.result.current.error).toBeNull()
  })

  it("mantém o chat íntegro no envio (POST + recarga, estados de espera)", async () => {
    const { chamadas, view } = usar({
      tarefas: [tarefa(1, "running")],
      chat: () => [{ id: 1, role: "user", texto: "oi", createdAt: "2026-09-13T10:00:00Z" }],
    })

    await waitFor(() => expect(view.result.current.chat).toHaveLength(1))

    act(() => view.result.current.setChatInput("mensagem nova"))
    await act(async () => {
      await view.result.current.sendChat()
    })

    const post = chamadas.find((c) => c.method === "POST" && c.path === "/gerenteagentes/tarefas/1/chat")
    expect(post?.body).toEqual({ role: "user", texto: "mensagem nova" })
    expect(view.result.current.chatInput).toBe("")
    expect(view.result.current.chatWaiting).toBe(true)
  })

  it("conecta o RealtimeClient da tarefa, aplica eventos e fecha ao trocar de tarefa", async () => {
    const { view } = usar({
      tarefas: [tarefa(1, "running"), tarefa(2, "planned")],
      detalheDoMotor: (id) => ({ exists: true, task: { status: "running", title: `Tarefa ${id}` } }),
    })

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const primeira = realtime.instances[0]
    expect(primeira?.options.taskId).toBe(1)
    expect(primeira?.conectado).toBe(1)
    await waitFor(() => expect(view.result.current.realtimeStatus).toBe("open"))

    // task.status.changed do motor reflete na tarefa em memória.
    act(() => {
      primeira?.emitir({
        type: "event",
        event: { type: "task.status.changed", taskId: 1, sequence: 1, occurredAt: "2026-09-13T10:01:00Z", payload: { status: "blocked" } },
      })
    })
    expect(view.result.current.tasks.find((t) => t.id === 1)?.status).toBe("blocked")

    // Trocar a seleção fecha o cliente anterior e abre um novo.
    act(() => view.result.current.select(2))
    await waitFor(() => expect(primeira?.fechado).toBe(1))
    await waitFor(() => expect(realtime.instances.length).toBeGreaterThan(1))
  })

  it("limita o buffer de eventos de tempo real (padrão 500, ajustável)", async () => {
    const { view } = usar(
      { tarefas: [tarefa(1, "running")] },
      { eventLimit: 3 },
    )

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const cliente = realtime.instances[0]

    act(() => {
      for (let seq = 1; seq <= 5; seq += 1) {
        cliente?.emitir({
          type: "event",
          event: { type: "subtask.delivered", taskId: 1, sequence: seq, occurredAt: "2026-09-13T10:02:00Z", payload: { seq } },
        })
      }
    })

    await waitFor(() => expect(eventosDe(view)).toHaveLength(3))
    const sequencias = eventosDe(view).map((e) => (e as { event: { sequence: number } }).event.sequence)
    expect(sequencias).toEqual([3, 4, 5])
  })

  it("recupera a fonte persistida quando o buffer do servidor expira (replay_unavailable)", async () => {
    const { chamadas, view } = usar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" } }),
    })

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const contarChat = () => chamadas.filter((c) => c.path === "/gerenteagentes/tarefas/1/chat").length
    const antes = contarChat()

    act(() => {
      realtime.instances[0]?.emitir({ type: "replay_unavailable" })
    })

    await waitFor(() => expect(contarChat()).toBeGreaterThan(antes))
    expect(view.result.current.realtimeStatus).toBe("open")
  })

  it("anexa eventos de chat por id (idempotente) e ignora o socket da tarefa antiga", async () => {
    const { view } = usar({
      tarefas: [tarefa(1, "running")],
      chat: () => [],
    })

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const cliente = realtime.instances[0]

    const eventoChat = {
      type: "event",
      event: {
        type: "task.chat.message.created",
        taskId: 1,
        sequence: 10,
        occurredAt: "2026-09-13T10:03:00Z",
        payload: { id: 99, role: "assistant", texto: "resposta da IA" },
      },
    }

    act(() => {
      cliente?.emitir(eventoChat)
      cliente?.emitir(eventoChat)
    })

    await waitFor(() => expect(view.result.current.chat).toHaveLength(1))
    expect(view.result.current.chat[0]?.texto).toBe("resposta da IA")
    expect(view.result.current.chatWaiting).toBe(false)
  })

  it("propaga connecting/open/closed e fecha o RealtimeClient ao desmontar", async () => {
    const { view } = usar({ tarefas: [tarefa(1, "running")] })

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const cliente = realtime.instances[0]
    await waitFor(() => expect(view.result.current.realtimeStatus).toBe("open"))

    act(() => cliente?.options.onStatusChange?.("closed"))
    expect(view.result.current.realtimeStatus).toBe("closed")
    act(() => cliente?.options.onStatusChange?.("connecting"))
    expect(view.result.current.realtimeStatus).toBe("connecting")

    view.unmount()
    expect(cliente?.fechado).toBe(1)
  })

  it("protege a seleção nova contra evento enfileirado da tarefa anterior", async () => {
    const { view } = usar({
      tarefas: [tarefa(1, "running"), tarefa(2, "planned")],
      detalheDoMotor: (id) => ({ exists: true, task: { status: "running", title: `Tarefa ${id}` } }),
    })

    await waitFor(() => expect(realtime.instances).toHaveLength(1))
    const primeira = realtime.instances[0]

    act(() => view.result.current.select(2))
    await waitFor(() => expect(view.result.current.selectedId).toBe(2))

    act(() => {
      primeira?.emitir({
        type: "event",
        event: { type: "task.chat.message.created", taskId: 1, sequence: 11, occurredAt: "2026-09-13T10:04:00Z", payload: { id: 111, role: "assistant", texto: "antiga" } },
      })
    })

    expect(view.result.current.chat).toHaveLength(0)
  })
})
