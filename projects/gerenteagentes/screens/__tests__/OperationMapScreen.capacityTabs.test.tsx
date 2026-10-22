// @vitest-environment jsdom
/**
 * Tarefa 1039 — Mapa de Agentes: pequenos ajustes.
 *
 * Cobre três critérios:
 * 1. Tarefa aguardando capacidade exibe SIMULTANEAMENTE o ícone de aguarde
 *    (ampulheta) e o número identificador (#id) no marcador do mapa.
 * 2. Ao receber `task.status.changed` para execução (running/analyzing), a
 *    projeção local de espera de capacidade é descartada imediatamente —
 *    ícone/tooltip do mapa e chip do detalhe desaparecem mesmo quando o
 *    evento não traz `capacityWait` no payload (era a causa do ícone obsoleto).
 * 3. A aba ativa do detalhe (Chat/Execução/Logs/Histórico) é preservada ao
 *    trocar de tarefa; a seleção inicial e a criação de tarefa nova continuam
 *    abrindo em Resumo.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"
import type { CapacityWaitProjection } from "../TaskFlowMap"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

/** RealtimeClient fake: expõe os handlers por canal/tarefa para injetar eventos. */
const realtime = vi.hoisted(() => ({
  clients: [] as Array<{ key: string; onMessage?: (message: unknown) => void }>,
}))

vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    constructor(options: { channel?: string; taskId?: number; onMessage?: (message: unknown) => void }) {
      const key = options.channel ?? `task:${options.taskId}`
      realtime.clients.push({ key, onMessage: options.onMessage })
    }
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
  },
}))

let mockIsWideScreen = true
vi.mock("@mui/material", async () => {
  const actual = await vi.importActual("@mui/material")
  return { ...actual, useMediaQuery: () => mockIsWideScreen }
})

const CAPACITY_WAIT: CapacityWaitProjection = {
  phase: "development",
  reasonCode: "global_limit",
  limitScope: "global",
  limitValue: 1,
  provider: null,
}

interface TarefaFake {
  id: number
  titulo: string
  status: string
  projetoId: number
  descricao: string | null
  dependsOnTaskId: number | null
  createdAt: string
  updatedAt: string
  capacityWait?: CapacityWaitProjection | null
}

function tarefaFactory(id: number, titulo: string, status: string, overrides: Partial<TarefaFake> = {}): TarefaFake {
  return {
    id,
    titulo,
    status,
    projetoId: 1,
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
    ...overrides,
  }
}

/**
 * Bundle fake com motor-detail por tarefa e chat por tarefa.
 * `detailStatus` define o status devolvido pelo motor-detail da tarefa esperada.
 */
function bundleFalso(
  tarefas: TarefaFake[],
  opts: {
    chats?: Record<number, Array<{ id: number; role: string; texto: string; createdAt: string }>>
    detailTask?: Record<string, unknown>
    chamadas?: string[]
  } = {},
) {
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (method: string, path: string) => {
        opts.chamadas?.push(`${method} ${path}`)
        if (method === "POST" && path === "/gerenteagentes/tarefas") {
          return { id: 77, projetoId: 1, titulo: "Tarefa recém-criada", descricao: "desc", tipo: "desenvolvimento", status: "draft", createdAt: "2026-10-22T12:00:00Z", updatedAt: "2026-10-22T12:00:00Z" }
        }
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
        if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") return { canStart: true, reasons: [], pendingRequests: 0 }
        if (path === "/gerenteagentes/timezone") return { timezone: "UTC", persistido: false }
        if (path === "/gerenteagentes/operational-feed") return { items: [] }
        const detailMatch = path.match(/\/gerenteagentes\/tarefas\/(\d+)\/motor-detail/)
        if (detailMatch) {
          const id = Number(detailMatch[1])
          const task = tarefas.find(t => t.id === id)
          return {
            motorId: "m1",
            exists: true,
            task: {
              status: task?.status ?? "planned",
              title: task?.titulo ?? `Tarefa ${id}`,
              descricao: task?.descricao ?? null,
              ...(opts.detailTask ?? {}),
            },
            subtasks: [],
          }
        }
        const chatMatch = path.match(/\/gerenteagentes\/tarefas\/(\d+)\/chat/)
        if (chatMatch) {
          const id = Number(chatMatch[1])
          return opts.chats?.[id] ?? []
        }
        if (path.endsWith("/subtarefas")) return []
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

function handlerPara(key: string) {
  return realtime.clients.findLast(client => client.key === key)?.onMessage
}

/** Injeta task.status.changed nos dois canais, como o servidor faz. */
function emitirStatusChanged(taskId: number, payload: Record<string, unknown>) {
  const event = {
    type: "event",
    event: {
      type: "task.status.changed",
      taskId,
      projectId: 1,
      occurredAt: "2026-10-22T13:00:00Z",
      payload,
    },
  }
  handlerPara("map")?.(event)
  handlerPara(`task:${taskId}`)?.(event)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete globalThis.__bundleMapa
  realtime.clients.length = 0
  mockIsWideScreen = true
})

describe("OperationMapCanvas — marcador com espera de capacidade", () => {
  it("exibe simultaneamente o ícone de aguarde e o número da tarefa no marcador", async () => {
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(50, "Tarefa aguardando vaga", "paused", { capacityWait: CAPACITY_WAIT }),
    ])
    renderScreen()

    await waitFor(() => {
      const marker = screen.getByTestId("operation-map-task-50")
      // Ícone de aguarde presente...
      expect(screen.getByTestId("operation-map-task-capacity-wait-50")).toBeInTheDocument()
      // ...e o número identificador continua visível (não some mais).
      expect(marker).toHaveTextContent("#50")
    })
  })

  it("mantém o número no marcador sem espera (comportamento padrão)", async () => {
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(51, "Tarefa normal", "paused"),
    ])
    renderScreen()

    await waitFor(() => {
      const marker = screen.getByTestId("operation-map-task-51")
      expect(marker).toHaveTextContent("#51")
      expect(screen.queryByTestId("operation-map-task-capacity-wait-51")).not.toBeInTheDocument()
    })
  })
})

describe("Realtime — limpeza da espera de capacidade ao passar para execução", () => {
  it("remove ícone e contorno de espera do marcador quando task.status.changed vai para running sem capacityWait no payload", async () => {
    // A linha de espera do tooltip é derivada da MESMA projeção (task.capacityWait)
    // que controla ícone e contorno; ao limpar a projeção, ícone, contorno e
    // tooltip deixam de existir juntos.
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(52, "Tarefa na fila de capacidade", "planned", { capacityWait: CAPACITY_WAIT }),
    ])
    renderScreen()

    await waitFor(() => expect(screen.getByTestId("operation-map-task-capacity-wait-52")).toBeInTheDocument())

    // Evento canônico do motor-v3: payload traz apenas previousStatus/status.
    await waitFor(() => expect(handlerPara("map")).toBeDefined())
    emitirStatusChanged(52, { previousStatus: "planned", status: "running" })

    await waitFor(() => {
      const markerAfter = screen.getByTestId("operation-map-task-52")
      // Ícone obsoleto sumiu...
      expect(screen.queryByTestId("operation-map-task-capacity-wait-52")).not.toBeInTheDocument()
      // ...o número continua visível (marker nunca perde o identificador)...
      expect(markerAfter).toHaveTextContent("#52")
      // ...e a tarefa migrou para a estação "Em execução".
      expect(within(screen.getByTestId("operation-station-running")).getByTestId("operation-map-task-52")).toBeInTheDocument()
    })
  })

  it("remove o chip 'Aguardando capacidade' do detalhe quando a tarefa selecionada passa para running", async () => {
    const tarefas = [tarefaFactory(53, "Tarefa em espera de capacidade", "paused", { capacityWait: CAPACITY_WAIT })]
    // motor-detail da tarefa 53: status pausado com a espera explícita.
    globalThis.__bundleMapa = bundleFalso(tarefas, { detailTask: { status: "paused", capacityWait: CAPACITY_WAIT } })
    renderScreen()

    await waitFor(() => expect(screen.getByTestId("detail-content")).toHaveTextContent("#53"))
    // Chip visível no detalhe antes do evento.
    expect(await screen.findByTestId("task-detail-capacity-wait-53")).toBeInTheDocument()

    await waitFor(() => expect(handlerPara("task:53")).toBeDefined())
    emitirStatusChanged(53, { previousStatus: "paused", status: "running" })

    await waitFor(() => {
      expect(screen.queryByTestId("task-detail-capacity-wait-53")).not.toBeInTheDocument()
    })
    // O marcador no mapa também ficou sem espera.
    const marker = screen.getByTestId("operation-map-task-53")
    expect(screen.queryByTestId("operation-map-task-capacity-wait-53")).not.toBeInTheDocument()
    expect(marker).toHaveTextContent("#53")
  })

  it("remove a espera quando o payload traz capacityWait explicitamente nulo junto do status", async () => {
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(54, "Tarefa com evento explícito", "ready", { capacityWait: CAPACITY_WAIT }),
    ])
    renderScreen()

    await screen.findByTestId("operation-map-task-capacity-wait-54")
    await waitFor(() => expect(handlerPara("map")).toBeDefined())
    emitirStatusChanged(54, { previousStatus: "ready", status: "running", capacityWait: null })

    await waitFor(() => {
      expect(screen.queryByTestId("operation-map-task-capacity-wait-54")).not.toBeInTheDocument()
    })
  })

  it("preserva a espera em status não-execução quando o evento não traz capacityWait", async () => {
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(55, "Tarefa na fila", "planned", { capacityWait: CAPACITY_WAIT }),
    ])
    renderScreen()

    await screen.findByTestId("operation-map-task-capacity-wait-55")
    await waitFor(() => expect(handlerPara("map")).toBeDefined())
    emitirStatusChanged(55, { previousStatus: "planned", status: "awaiting_clarification" })

    await waitFor(() => {
      const marker = screen.getByTestId("operation-map-task-55")
      expect(screen.getByTestId("operation-map-task-capacity-wait-55")).toBeInTheDocument()
      expect(marker).toHaveTextContent("#55")
    })
  })

  it("limpa a espera via task.updated (applyTaskUpdate) quando o status resultante é de execução", async () => {
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(56, "Tarefa aguardando e iniciando", "planned", { capacityWait: CAPACITY_WAIT }),
    ])
    renderScreen()

    await screen.findByTestId("operation-map-task-capacity-wait-56")
    await waitFor(() => expect(handlerPara("map")).toBeDefined())
    handlerPara("map")?.({
      type: "event",
      event: {
        type: "task.updated",
        taskId: 56,
        projectId: 1,
        occurredAt: "2026-10-22T13:00:00Z",
        payload: { title: "Tarefa aguardando e iniciando", status: "analyzing" },
      },
    })

    await waitFor(() => {
      const marker = screen.getByTestId("operation-map-task-56")
      expect(screen.queryByTestId("operation-map-task-capacity-wait-56")).not.toBeInTheDocument()
      expect(marker).toHaveTextContent("#56")
    })
  })
})

describe("Preservação da aba ativa ao trocar de tarefa", () => {
  async function setupDuasTarefas() {
    // t2 (paused) vence a seleção inicial; t1 (planned) será clicada pelo usuário.
    const tarefas = [
      tarefaFactory(1, "Primeira tarefa", "planned", { updatedAt: "2026-09-10T12:00:00Z" }),
      tarefaFactory(2, "Segunda tarefa", "paused", { updatedAt: "2026-09-13T12:00:00Z" }),
    ]
    globalThis.__bundleMapa = bundleFalso(tarefas, {
      chats: {
        1: [{ id: 101, role: "user", texto: "mensagem da tarefa um", createdAt: "2026-09-13T12:30:00Z" }],
        2: [{ id: 202, role: "user", texto: "mensagem da tarefa dois", createdAt: "2026-09-13T12:30:00Z" }],
      },
    })
    renderScreen()
    await waitFor(() => expect(screen.getByTestId("detail-content")).toHaveTextContent("#2 Segunda tarefa"), { timeout: 5000 })
  }

  it("abre a seleção inicial na aba Resumo", async () => {
    await setupDuasTarefas()
    expect(screen.getByRole("tab", { name: "Resumo" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByTestId("operation-chat-history")).not.toBeInTheDocument()
  })

  it("mantém a aba Chat ao clicar em outra tarefa", async () => {
    await setupDuasTarefas()

    // Usuário abre a tarefa 1 e entra na aba Chat.
    fireEvent.click(await screen.findByTestId("operation-map-task-1"))
    await waitFor(() => expect(screen.getByTestId("detail-content")).toHaveTextContent("#1 Primeira tarefa"))
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }))
    expect(await screen.findByText("mensagem da tarefa um")).toBeInTheDocument()

    // Clique em outra tarefa: a aba Chat deve continuar ativa, agora com o chat da tarefa 2.
    fireEvent.click(screen.getByTestId("operation-map-task-2"))
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#2 Segunda tarefa")
      expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true")
      expect(screen.getByRole("tab", { name: "Resumo" })).toHaveAttribute("aria-selected", "false")
    })
    expect(await screen.findByText("mensagem da tarefa dois")).toBeInTheDocument()
  })

  it("mantém a aba Execução ao clicar em outra tarefa", async () => {
    await setupDuasTarefas()

    fireEvent.click(await screen.findByTestId("operation-map-task-1"))
    fireEvent.click(screen.getByRole("tab", { name: "Execução" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Execução" })).toHaveAttribute("aria-selected", "true"))

    fireEvent.click(screen.getByTestId("operation-map-task-2"))
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#2 Segunda tarefa")
      expect(screen.getByRole("tab", { name: "Execução" })).toHaveAttribute("aria-selected", "true")
    })
  })

  it("mantém as abas Logs e Histórico ao trocar de tarefa", async () => {
    await setupDuasTarefas()

    fireEvent.click(await screen.findByTestId("operation-map-task-1"))
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }))
    fireEvent.click(screen.getByTestId("operation-map-task-2"))
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#2 Segunda tarefa")
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true")
    })

    fireEvent.click(screen.getByTestId("operation-map-task-1"))
    await waitFor(() => expect(screen.getByTestId("detail-content")).toHaveTextContent("#1 Primeira tarefa"))
    fireEvent.click(screen.getByRole("tab", { name: "Histórico" }))
    fireEvent.click(screen.getByTestId("operation-map-task-2"))
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#2 Segunda tarefa")
      expect(screen.getByRole("tab", { name: "Histórico" })).toHaveAttribute("aria-selected", "true")
    })
  })

})
