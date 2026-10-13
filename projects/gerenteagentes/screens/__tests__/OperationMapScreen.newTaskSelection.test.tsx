// @vitest-environment jsdom
/**
 * Seleção automática da tarefa recém-criada no Mapa de agentes (tarefa 996).
 *
 * Valida:
 * - POST /gerenteagentes/tarefas bem-sucedido → diálogo fecha, a tarefa retornada
 *   pela API entra na lista local e fica automaticamente selecionada com o
 *   detalhe aberto na aba "Resumo" (tab 0), sem clique manual.
 * - O detalhe é carregado pelos caminhos existentes de selectedId
 *   (motor-detail/subtarefas/chat do novo id) ainda antes do evento WebSocket.
 * - O evento task.created via WebSocket não duplica a tarefa (dedupe por id — REQ-2).
 * - Em caso de erro na criação, o diálogo permanece aberto com a mensagem de
 *   erro e a seleção atual não muda.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

/**
 * RealtimeClient fake: expõe os handlers por canal para os testes injetarem
 * eventos (map_snapshot / task.created) como o servidor faria.
 */
const realtime = vi.hoisted(() => ({
  handlers: {} as Record<string, (message: unknown) => void>,
}))

vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    constructor(options: { channel?: string; taskId?: number; onMessage?: (message: unknown) => void }) {
      const key = options.channel ?? `task:${options.taskId}`
      realtime.handlers[key] = options.onMessage ?? (() => {})
    }
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
  },
}))

let mockIsWideScreen = true
vi.mock("@mui/material", async () => {
  const actual = await vi.importActual("@mui/material")
  return {
    ...actual,
    useMediaQuery: () => mockIsWideScreen,
  }
})

interface TarefaFake {
  id: number
  titulo: string
  status: string
  projetoId: number
  descricao: string | null
  dependsOnTaskId: number | null
  createdAt: string
  updatedAt: string
}

function tarefaFactory(id: number, titulo: string, status = "planned"): TarefaFake {
  return {
    id,
    titulo,
    status,
    projetoId: 1,
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  }
}

interface BundleOps {
  /** Linha que o POST /gerenteagentes/tarefas devolve (shape da API criarTarefa). */
  createdRow?: Record<string, unknown> | null
  /** Se definido, o POST rejeita com esta mensagem. */
  createError?: string
  chamadas: string[]
}

/** Bundle fake: lista com uma tarefa inicial e contador de tarefas no POST. */
function bundleFalso(tarefas: TarefaFake[], ops: BundleOps) {
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (method: string, path: string) => {
        ops.chamadas.push(`${method} ${path}`)
        if (method === "POST" && path === "/gerenteagentes/tarefas") {
          if (ops.createError) throw new Error(ops.createError)
          return ops.createdRow ?? null
        }
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") {
          return { items: [{ id: 1, nome: "Projeto X" }] }
        }
        if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") {
          return { canStart: true, reasons: [], pendingRequests: 0 }
        }
        if (path === "/gerenteagentes/timezone") return { timezone: "UTC", persistido: false }
        if (path === "/gerenteagentes/operational-feed") return { items: [] }
        if (path.endsWith("/motor-detail")) {
          return { motorId: "m1", exists: false, message: `Detalhe de ${path}` }
        }
        if (path.endsWith("/subtarefas")) return []
        if (path.endsWith("/chat")) return []
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

/** Localiza o `div role=combobox` do select MUI (mesma técnica de NovaTarefaScreen.test). */
function comboboxDoCampo(testId: string): HTMLElement {
  const input = screen.getByTestId(testId)
  const combobox = input.previousElementSibling as HTMLElement | null
  if (!combobox) throw new Error("combobox do campo não encontrado: " + testId)
  return combobox
}

/** Abre o diálogo "Nova tarefa" e preenche o formulário. */
async function abrirEDialogo(user: ReturnType<typeof userEvent.setup>, titulo: string) {
  await user.click(await screen.findByRole("button", { name: "Nova tarefa" }))
  await screen.findByText("Nova tarefa", { selector: ".MuiDialogTitle-root" })
  await user.click(comboboxDoCampo("input-projeto-id"))
  const opcao = screen.queryAllByRole("option").find(o => o.getAttribute("data-value") === "1")
  await user.click(opcao!)
  await user.type(screen.getByTestId("input-titulo"), titulo)
  // Fecha o popover do select, se ainda estiver aberto (animação do MUI).
  if (screen.queryByRole("listbox")) await user.keyboard("{Escape}")
}

/** Envia o formulário tolerando o popover em animação sobre o botão. */
async function clicarEnviar(user: ReturnType<typeof userEvent.setup>) {
  const btn = screen.getByTestId("btn-enviar")
  if (getComputedStyle(btn).pointerEvents === "none") {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    return
  }
  await user.click(btn)
}

/** Linha criada no formato devolvido por criarTarefa (registro Drizzle completo). */
function linhaCriada(id: number, titulo: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    externalId: `task-p1-${id}`,
    projetoId: 1,
    titulo,
    descricao: "descricao da nova tarefa",
    tipo: "desenvolvimento",
    maxRework: 3,
    dependsOnTaskId: null,
    autoStart: false,
    pausedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete globalThis.__bundleMapa
  mockIsWideScreen = true
})

describe("OperationMapScreen — seleção automática de tarefa nova", () => {
  it("auto-seleciona a tarefa criada pelo diálogo, com detalhe aberto na aba Resumo", async () => {
    mockIsWideScreen = true
    const ops: BundleOps = { chamadas: [], createdRow: linhaCriada(77, "Tarefa recém-criada", "2026-10-12T18:00:00Z") }
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa inicial", "planned")], ops)
    const user = userEvent.setup()
    renderScreen()

    // Carga inicial: a tarefa 1 é selecionada automaticamente (sem interação).
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("Tarefa inicial")
    }, { timeout: 5000 })

    await abrirEDialogo(user, "Tarefa recém-criada")
    await clicarEnviar(user)

    // (a) Diálogo fecha após o POST bem-sucedido.
    await waitFor(() => {
      expect(screen.queryByText("Nova tarefa", { selector: ".MuiDialogTitle-root" })).not.toBeInTheDocument()
    }, { timeout: 5000 })

    // (b) A nova tarefa entra na lista local (visível no canvas) e fica selecionada
    // com o detalhe aberto — sem nenhum clique manual.
    await waitFor(() => {
      expect(screen.getByTestId("operation-map-task-77")).toBeInTheDocument()
    }, { timeout: 5000 })
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#77 Tarefa recém-criada")
    }, { timeout: 5000 })

    // Aba inicial é "Resumo" (tab 0): o chat (aba 1) ainda não foi montado.
    expect(screen.getByRole("tab", { name: "Resumo" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByTestId("operation-chat-history")).not.toBeInTheDocument()

    // (c) O detalhe foi carregado pelos caminhos existentes de selectedId para o novo id.
    await waitFor(() => {
      expect(ops.chamadas).toContain("GET /gerenteagentes/tarefas/77/motor-detail")
      expect(ops.chamadas).toContain("GET /gerenteagentes/tarefas/77/subtarefas")
      expect(ops.chamadas).toContain("GET /gerenteagentes/tarefas/77/chat")
    }, { timeout: 5000 })

    // POST de criação foi a chamada que produziu o id.
    expect(ops.chamadas).toContain("POST /gerenteagentes/tarefas")
  })

  it("evento task.created tardio do WebSocket não duplica a tarefa já inserida pela resposta da API", async () => {
    mockIsWideScreen = true
    const created = linhaCriada(78, "Tarefa WebSocket", "2026-10-12T18:00:00Z")
    const ops: BundleOps = { chamadas: [], createdRow: created }
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa inicial", "planned")], ops)
    const user = userEvent.setup()
    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("Tarefa inicial")
    }, { timeout: 5000 })

    await abrirEDialogo(user, "Tarefa WebSocket")
    await clicarEnviar(user)

    // A resposta do POST já inseriu a tarefa na lista local (antes do WebSocket).
    await waitFor(() => {
      expect(screen.getByTestId("operation-map-task-78")).toBeInTheDocument()
    }, { timeout: 5000 })

    // Evento tardio task.created para a mesma tarefa — o handler do canal "map"
    // deduplica por id (REQ-2): a tarefa deve aparecer exatamente uma vez.
    realtime.handlers.map?.({
      type: "event",
      event: {
        type: "task.created",
        taskId: 78,
        projectId: 1,
        occurredAt: "2026-10-12T18:00:01Z",
        payload: { title: "Tarefa WebSocket", status: "draft" },
      },
    })

    await waitFor(() => {
      expect(screen.getByTestId("operation-map-task-78")).toBeInTheDocument()
    })
    expect(screen.getAllByTestId("operation-map-task-78")).toHaveLength(1)
    // Seleção permanece na tarefa recém-criada (dedupe não sobrescreve seleção).
    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("#78 Tarefa WebSocket")
    }, { timeout: 5000 })
  })

  it("erro na criação mantém o diálogo aberto com a mensagem e não muda a seleção", async () => {
    mockIsWideScreen = true
    const ops: BundleOps = { chamadas: [], createError: "serviço indisponível" }
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(1, "Tarefa inicial", "planned")], ops)
    const user = userEvent.setup()
    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("detail-content")).toHaveTextContent("Tarefa inicial")
    }, { timeout: 5000 })

    await abrirEDialogo(user, "Tarefa que falhou")
    await clicarEnviar(user)

    // Mensagem de erro exibida e diálogo continua aberto.
    await waitFor(() => {
      expect(screen.getByTestId("api-error")).toHaveTextContent("serviço indisponível")
    }, { timeout: 5000 })
    expect(screen.getByText("Nova tarefa", { selector: ".MuiDialogTitle-root" })).toBeInTheDocument()

    // Seleção atual inalterada; nenhuma tarefa nova entrou na lista.
    expect(screen.getByTestId("detail-content")).toHaveTextContent("Tarefa inicial")
    expect(screen.queryByTestId("operation-map-task-77")).not.toBeInTheDocument()
    expect(screen.queryByTestId("operation-map-task-78")).not.toBeInTheDocument()
  })
})
