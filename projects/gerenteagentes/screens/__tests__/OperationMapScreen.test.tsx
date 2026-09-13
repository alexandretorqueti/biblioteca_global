// @vitest-environment jsdom
/**
 * Testes de paridade da tela nova "Mapa de agentes" (subtarefa 1086).
 *
 * A tela é apenas apresentação: as leituras, o polling, o tempo real, a seleção
 * e as ações vêm de `useOperationMapData`. Aqui validamos, na UI:
 * - seleção abre o detalhe na tela (sem navegar de página/rota);
 * - habilitação e erro de start/pause/resume;
 * - fallback de subtarefas (motor-detail vazio → banco);
 * - chat (Ctrl+Enter → POST) e estado de espera;
 * - buffer de eventos de tempo real com limite, exposto na aba Logs.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"
import type { OperationMapChatMessage, OperationMapDbSubtask, OperationMapDetail, OperationMapTask } from "../operationMapData"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

const realtime = vi.hoisted(() => {
  interface OpcoesRealtime {
    taskId?: number
    onMessage?: (mensagem: unknown) => void
    onStatusChange?: (status: "connecting" | "open" | "closed") => void
  }
  class FakeRealtime {
    options: OpcoesRealtime
    constructor(options: OpcoesRealtime) {
      this.options = options
      fake.instances.push(this)
      queueMicrotask(() => fake.instances.length && this.options.onStatusChange?.("open"))
    }
    async connect() { this.options.onStatusChange?.("open") }
    close() { this.options.onStatusChange?.("closed") }
    emitir(mensagem: unknown) { this.options.onMessage?.(mensagem) }
  }
  const fake = { instances: [] as FakeRealtime[], FakeRealtime }
  return fake
})

vi.mock("@biblioteca-global/api-client", () => ({ RealtimeClient: realtime.FakeRealtime }))

type Chamada = { method: string; path: string; body?: unknown }

interface Cenario {
  tarefas?: OperationMapTask[]
  detalheDoMotor?: (id: number) => OperationMapDetail
  subtarefasDoBanco?: (id: number) => OperationMapDbSubtask[]
  chat?: (id: number) => OperationMapChatMessage[]
  falharAcao?: boolean
}

function tarefa(id: number, status: string, extra?: Partial<OperationMapTask>): OperationMapTask {
  return {
    id,
    titulo: `Tarefa ${id}`,
    status,
    projetoId: 1,
    descricao: `Descrição da tarefa ${id}`,
    createdAt: "2026-09-13T10:00:00Z",
    updatedAt: "2026-09-13T10:00:00Z",
    ...extra,
  }
}

function montarBundle(cenario: Cenario = {}) {
  const chamadas: Chamada[] = []
  const bundle = {
    http: {
      request: async (method: string, path: string, options?: { body?: unknown }) => {
        chamadas.push({ method, path, body: options?.body })
        if (method === "GET" && path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Global" }] }
        if (method === "GET" && path === "/gerenteagentes/tarefas-com-status") return cenario.tarefas ?? [tarefa(1, "running")]
        if (method === "GET" && path === "/gerenteagentes/motor-activity") return { activities: [] }
        if (method === "GET" && path === "/gerenteagentes/motor-deploy-diagnostics") return { canStart: true, reasons: ["ok"], pendingRequests: 0 }
        const motorDetail = /^\/gerenteagentes\/tarefas\/(\d+)\/motor-detail$/.exec(path)
        if (method === "GET" && motorDetail) {
          return cenario.detalheDoMotor?.(Number(motorDetail[1])) ?? { exists: true, task: { status: "running", title: `Tarefa ${motorDetail[1]}` } }
        }
        const subtarefas = /^\/gerenteagentes\/tarefas\/(\d+)\/subtarefas$/.exec(path)
        if (method === "GET" && subtarefas) return cenario.subtarefasDoBanco?.(Number(subtarefas[1])) ?? []
        const chat = /^\/gerenteagentes\/tarefas\/(\d+)\/chat$/.exec(path)
        if (method === "GET" && chat) return cenario.chat?.(Number(chat[1])) ?? []
        if (method === "POST" && /\/gerenteagentes\/tarefas\/\d+\/(start|pause|resume|unlock)$/.test(path)) {
          if (cenario.falharAcao) throw new Error("Falha simulada na ação")
          return { ok: true }
        }
        return {}
      },
    },
    getAccessToken: () => "token-falso",
  }
  return { chamadas, bundle }
}

function renderizar(cenario: Cenario = {}) {
  const servidor = montarBundle(cenario)
  globalThis.__bundleFalso = servidor.bundle as never
  const view = render(
    <BibliotecaThemeProvider>
      <OperationMapScreen />
    </BibliotecaThemeProvider>,
  )
  return { ...servidor, view }
}

async function abrirTarefa(id: number) {
  // Clica no marcador do mapa (mesmo caminho de seleção da tela) e espera o
  // painel lateral. Não navega de rota.
  fireEvent.click(await screen.findByTestId(`operation-map-task-${id}`))
  const drawer = await screen.findByTestId("operation-task-drawer")
  return within(drawer)
}

describe("OperationMapScreen — paridade de dados e interações", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    realtime.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    delete globalThis.__bundleFalso
    vi.unstubAllGlobals()
  })

  it("seleciona a tarefa pelo mapa e abre o detalhe sem navegar de rota", async () => {
    const { chamadas, view } = renderizar({
      tarefas: [tarefa(1, "running"), tarefa(2, "planned")],
      detalheDoMotor: (id) => ({ exists: true, task: { status: "planned", title: `Tarefa ${id}` } }),
    })

    const drawer = await abrirTarefa(2)

    expect(drawer.getByText("#2 Tarefa 2")).toBeInTheDocument()
    // o detalhe é carregado pelo mesmo endpoint da tela legada
    await waitFor(() =>
      expect(chamadas.some((c) => c.path === "/gerenteagentes/tarefas/2/motor-detail")).toBe(true),
    )
    // seleção não navega: a tela do mapa continua montada ao lado do painel
    expect(screen.getByTestId("operation-map-canvas")).toBeInTheDocument()
    view.unmount()
  })

  it("mantém a habilitação de iniciar/pausar/retomar conforme o status e mostra o erro da ação", async () => {
    const { view } = renderizar({
      tarefas: [tarefa(1, "running"), tarefa(2, "paused")],
      detalheDoMotor: (id) => ({ exists: true, task: { status: id === 2 ? "paused" : "running", title: `Tarefa ${id}` } }),
      falharAcao: true,
    })

    const drawer = await abrirTarefa(2)
    const iniciar = drawer.getByRole("button", { name: "Iniciar" })
    const pausar = drawer.getByRole("button", { name: "Pausar" })
    const retomar = drawer.getByRole("button", { name: "Retomar" })

    await waitFor(() => expect(iniciar).toBeEnabled())
    expect(pausar).toBeDisabled()
    expect(retomar).toBeEnabled()

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(iniciar)

    expect(await screen.findByText("Falha simulada na ação")).toBeInTheDocument()
    view.unmount()
  })

  it("cai para as subtarefas do banco quando o motor-detail não traz nenhuma", async () => {
    const { view } = renderizar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" }, subtasks: [] }),
      subtarefasDoBanco: () => [
        { id: 5, seq: 1, titulo: "Fallback do banco", status: "delivered", scope: "escopo do fallback" },
      ],
    })

    const drawer = await abrirTarefa(1)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(drawer.getByRole("tab", { name: "Execução" }))

    expect(await drawer.findByText(/Fallback do banco/)).toBeInTheDocument()
    view.unmount()
  })

  it("envia mensagem no chat com Ctrl+Enter (POST na mesma rota) e mostra o estado de espera", async () => {
    const { chamadas, view } = renderizar({
      tarefas: [tarefa(1, "running")],
      chat: () => [{ id: 1, role: "user", texto: "primeira", createdAt: "2026-09-13T10:00:00Z" }],
    })

    const drawer = await abrirTarefa(1)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(drawer.getByRole("tab", { name: "Chat" }))

    const campo = await drawer.findByTestId("operation-chat-input")
    await user.type(campo, "preciso de ajuda")
    fireEvent.keyDown(campo, { key: "Enter", ctrlKey: true })

    await waitFor(() => {
      const post = chamadas.find((c) => c.method === "POST" && c.path === "/gerenteagentes/tarefas/1/chat")
      expect(post?.body).toEqual({ role: "user", texto: "preciso de ajuda" })
    })

    expect(await drawer.findByText("Agente está respondendo…")).toBeInTheDocument()
    view.unmount()
  })

  it("expõe o buffer de eventos de tempo real (com limite) na aba Logs", async () => {
    const { view } = renderizar({
      tarefas: [tarefa(1, "running")],
      detalheDoMotor: () => ({ exists: true, task: { status: "running", title: "Tarefa 1" } }),
    })

    const drawer = await abrirTarefa(1)
    await waitFor(() => expect(realtime.instances.length).toBeGreaterThan(0))

    const cliente = realtime.instances[0]
    cliente?.emitir({
      type: "event",
      event: { type: "subtask.started", taskId: 1, sequence: 7, occurredAt: "2026-09-13T10:05:00Z", payload: { seq: 2 } },
    })

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(drawer.getByRole("tab", { name: "Logs" }))

    const blocoTempoReal = await drawer.findByTestId("operation-realtime-events")
    expect(blocoTempoReal).toHaveTextContent("Tempo real")
    expect(blocoTempoReal).toHaveTextContent("Subtarefa iniciada")
    view.unmount()
  })
})
