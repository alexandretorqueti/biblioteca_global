// @vitest-environment jsdom
/**
 * Rolagem automática do histórico do chat da tarefa (Mapa de agentes).
 *
 * Cobre os critérios de aceite da subtarefa:
 * - rolar ao fim após o POST de envio (atualização local via loadChat);
 * - rolar ao fim ao receber `task.chat.message.created` pelo canal realtime;
 * - rolar quando a aba Chat é exibida;
 * - comportamento válido nas duas apresentações do painel de detalhe
 *   (coluna larga e Drawer móvel).
 *
 * O jsdom não faz layout: `scrollHeight` é sempre 0. Os testes instalam
 * observadores no protótipo (`scrollHeight` fixo + gravações de `scrollTop`)
 * e verificam que o contêiner `operation-chat-history` foi rolado ao fim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

const realtimeClients = vi.hoisted(() => ({
  items: [] as Array<{ taskId?: number; channel?: string; onMessage?: (message: unknown) => void }>,
}))

vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    constructor(options: { taskId?: number; channel?: string; onMessage?: (message: unknown) => void }) {
      realtimeClients.items.push(options)
    }
    connect(): void { /* no-op nos testes */ }
    close(): void { /* no-op nos testes */ }
  },
}))

// Controla a apresentação do painel de detalhe: larga (coluna fixa) ou móvel (Drawer).
let mockIsWideScreen = true
vi.mock("@mui/material", async () => {
  const actual = await vi.importActual("@mui/material")
  return {
    ...actual,
    useMediaQuery: () => mockIsWideScreen,
  }
})

import OperationMapScreen from "../OperationMapScreen"

const SCROLL_HEIGHT = 1200

/** Elementos rolados ao fim durante o teste (gravações scrollTop >= scrollHeight). */
let rolados: HTMLElement[] = []
let originalScrollTop: PropertyDescriptor | undefined
let originalScrollHeight: PropertyDescriptor | undefined

function instalarObservadorDeRolagem() {
  rolados = []
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
  originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  })
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => 0,
    set(this: HTMLElement, value: number) {
      if (value >= SCROLL_HEIGHT) rolados.push(this)
    },
  })
}

function restaurarObservadorDeRolagem() {
  if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
}

/** O contêiner do chat foi rolado ao fim desde a última limpeza de `rolados`. */
function historicoRoladoAoFim() {
  return rolados.some(element => element.getAttribute("data-testid") === "operation-chat-history")
}

interface TarefaFake {
  id: number; titulo: string; status: string; projetoId: number
  descricao: string | null; dependsOnTaskId: number | null; createdAt: string; updatedAt: string
}

function tarefaFactory(id: number): TarefaFake {
  return {
    id,
    titulo: "Tarefa com chat",
    status: "running",
    projetoId: 1,
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-10-15T12:00:00Z",
    updatedAt: "2026-10-15T12:00:00Z",
  }
}

/**
 * Bundle fake: o GET /chat sempre devolve duas mensagens; o POST /chat é
 * registrado. Assim, após o envio, `loadChat` produz um novo array de chat e
 * o efeito de rolagem deve rodar de novo.
 */
function bundleFalso(tarefaId: number, chamadas: string[]) {
  const mensagens = [
    { id: 1, tarefaId, role: "user", texto: "Oi, agente.", createdAt: "2026-10-15T12:01:00Z" },
    { id: 2, tarefaId, role: "assistant", texto: "Olá! Estou na fase de análise.", createdAt: "2026-10-15T12:02:00Z" },
  ]
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (method: string, path: string) => {
        chamadas.push(`${method} ${path}`)
        if (path === "/gerenteagentes/tarefas-com-status") return [tarefaFactory(tarefaId)]
        if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
        if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") return { canStart: true, reasons: [], pendingRequests: 0 }
        if (path.endsWith("/motor-detail")) return { motorId: "m1", exists: true, task: { status: "running", title: "Tarefa com chat" }, subtasks: [] }
        if (path.endsWith("/subtarefas")) return []
        if (method === "GET" && path.endsWith("/chat")) return mensagens
        if (method === "POST" && path.endsWith("/chat")) return { ok: true }
        return {}
      },
    },
  }
}

function renderScreen() {
  return render(
    <BibliotecaThemeProvider>
      <OperationMapScreen />
    </BibliotecaThemeProvider>,
  )
}

/** Seleciona a tarefa e abre a aba Chat no painel de detalhe visível. */
async function abrirAbaChat(taskId: number) {
  await screen.findByTestId(`operation-map-task-${taskId}`)
  if (!mockIsWideScreen) {
    // Apresentação móvel: o detalhe abre em Drawer ao clicar na tarefa.
    fireEvent.click(screen.getByTestId(`operation-map-task-${taskId}`))
    await screen.findByTestId("operation-task-drawer")
  }
  // O feed operacional também usa Tabs; mirar a aba do detalhe por nome.
  fireEvent.click(await screen.findByRole("tab", { name: "Chat" }))
  return screen.findByTestId("operation-chat-history")
}

/** Dispara um evento realtime no cliente do canal "task" da tarefa informada. */
function emitirEventoTask(taskId: number, event: unknown) {
  const client = [...realtimeClients.items].reverse().find(item => item.taskId === taskId)
  if (!client?.onMessage) throw new Error(`Cliente realtime do canal task ${taskId} não encontrado`)
  client.onMessage(event)
}

beforeEach(() => {
  instalarObservadorDeRolagem()
})

afterEach(() => {
  restaurarObservadorDeRolagem()
  vi.restoreAllMocks()
  delete globalThis.__bundleMapa
  realtimeClients.items.length = 0
})

describe("OperationMapScreen — rolagem automática do chat (apresentação larga)", () => {
  beforeEach(() => {
    mockIsWideScreen = true
  })

  it("rola ao fim quando a aba Chat é exibida com mensagens carregadas", async () => {
    globalThis.__bundleMapa = bundleFalso(21, [])
    renderScreen()
    await abrirAbaChat(21)

    // Reentrada na aba (Resumo → Chat) deve reacionar o efeito de rolagem.
    fireEvent.click(screen.getByRole("tab", { name: "Resumo" }))
    await waitFor(() => expect(screen.queryByTestId("operation-chat-history")).not.toBeInTheDocument())
    rolados = []
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }))
    await screen.findByTestId("operation-chat-history")
    await waitFor(() => expect(historicoRoladoAoFim()).toBe(true))
  })

  it("rola ao fim após enviar mensagem (atualização local pós-POST)", async () => {
    const chamadas: string[] = []
    globalThis.__bundleMapa = bundleFalso(21, chamadas)
    renderScreen()
    await abrirAbaChat(21)

    await userEvent.type(screen.getByTestId("operation-chat-input"), "Nova mensagem")
    rolados = []
    fireEvent.click(screen.getByRole("button", { name: /Enviar/ }))

    await waitFor(() => expect(chamadas).toContain("POST /gerenteagentes/tarefas/21/chat"))
    await waitFor(() => expect(historicoRoladoAoFim()).toBe(true))
  })

  it("rola ao fim ao receber task.chat.message.created pelo canal realtime", async () => {
    globalThis.__bundleMapa = bundleFalso(21, [])
    renderScreen()
    await abrirAbaChat(21)

    await waitFor(() => {
      expect(realtimeClients.items.some(item => item.taskId === 21)).toBe(true)
    })
    rolados = []
    emitirEventoTask(21, {
      type: "event",
      event: {
        type: "task.chat.message.created",
        occurredAt: "2026-10-15T12:03:00Z",
        payload: { id: 99, role: "assistant", texto: "Entreguei a subtarefa.", createdAt: "2026-10-15T12:03:00Z" },
      },
    })

    expect(await screen.findByText("Entreguei a subtarefa.")).toBeInTheDocument()
    await waitFor(() => expect(historicoRoladoAoFim()).toBe(true))
  })
})

describe("OperationMapScreen — rolagem automática do chat (apresentação móvel)", () => {
  beforeEach(() => {
    mockIsWideScreen = false
  })

  it("rola ao fim no Drawer ao receber mensagem realtime", async () => {
    globalThis.__bundleMapa = bundleFalso(22, [])
    renderScreen()
    await abrirAbaChat(22)

    await waitFor(() => {
      expect(realtimeClients.items.some(item => item.taskId === 22)).toBe(true)
    })
    rolados = []
    emitirEventoTask(22, {
      type: "event",
      event: {
        type: "task.chat.message.created",
        occurredAt: "2026-10-15T12:04:00Z",
        payload: { id: 100, role: "assistant", texto: "Mensagem pelo Drawer.", createdAt: "2026-10-15T12:04:00Z" },
      },
    })

    expect(await screen.findByText("Mensagem pelo Drawer.")).toBeInTheDocument()
    await waitFor(() => expect(historicoRoladoAoFim()).toBe(true))
  })
})
