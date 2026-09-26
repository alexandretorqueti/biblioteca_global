// @vitest-environment jsdom
/**
 * Testes de seleção inicial e comportamento do detalhe do OperationMapScreen.
 *
 * Valida:
 * - Seleção inicial prioriza tarefas com status awaiting_clarification ou paused
 * - Fallback para tarefa concluída mais recentemente
 * - Comportamento do detalhe em telas largas (sempre visível) e pequenas (Drawer)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
  },
}))

// Mock do useMediaQuery para controlar resposta nos testes
let mockIsWideScreen = false
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

function tarefaFactory(
  id: number,
  titulo: string,
  status: string,
  updatedAt: string = "2026-09-13T12:00:00Z",
  createdAt: string = "2026-09-13T12:00:00Z",
): TarefaFake {
  return {
    id,
    titulo,
    status,
    projetoId: 1,
    descricao: null,
    dependsOnTaskId: null,
    createdAt,
    updatedAt,
  }
}

function bundleFalso(tarefas: TarefaFake[]) {
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (method: string, path: string) => {
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") {
          return { items: [{ id: 1, nome: "Projeto X" }] }
        }
        if (path === "/gerenteagentes/motor-activity") return { activities: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") {
          return { canStart: true, reasons: [], pendingRequests: 0 }
        }
        if (path.endsWith("/motor-detail")) {
          return { motorId: "m1", exists: false, message: "Não enviada" }
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

describe("OperationMapScreen — seleção inicial determinística", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
    mockIsWideScreen = false
  })

  it("seleciona tarefa com status awaiting_clarification mais recente", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa antiga aguardando", "awaiting_clarification", "2026-09-10T12:00:00Z"),
      tarefaFactory(2, "Tarefa recente aguardando", "awaiting_clarification", "2026-09-13T12:00:00Z"),
      tarefaFactory(3, "Tarefa em execução", "running", "2026-09-12T12:00:00Z"),
    ])
    renderScreen()

    // Aguarda a tarefa mais recente ser selecionada e aparecer no detalhe
    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa recente aguardando")
    }, { timeout: 5000 })
  })

  it("seleciona tarefa com status paused mais recente quando não há awaiting_clarification", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa antiga pausada", "paused", "2026-09-10T12:00:00Z"),
      tarefaFactory(2, "Tarefa recente pausada", "paused", "2026-09-13T12:00:00Z"),
      tarefaFactory(3, "Tarefa em execução", "running", "2026-09-12T12:00:00Z"),
    ])
    renderScreen()

    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa recente pausada")
    }, { timeout: 5000 })
  })

  it("fallback: seleciona tarefa concluída mais recentemente quando não há tarefas aguardando", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa concluída antiga", "completed", "2026-09-10T12:00:00Z"),
      tarefaFactory(2, "Tarefa concluída recente", "completed", "2026-09-13T12:00:00Z"),
      tarefaFactory(3, "Tarefa em execução", "running", "2026-09-12T12:00:00Z"),
    ])
    renderScreen()

    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa concluída recente")
    }, { timeout: 5000 })
  })

  it("fallback usa createdAt quando updatedAt é igual", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa concluída antiga", "completed", "2026-09-13T12:00:00Z", "2026-09-10T12:00:00Z"),
      tarefaFactory(2, "Tarefa concluída recente", "completed", "2026-09-13T12:00:00Z", "2026-09-13T12:00:00Z"),
    ])
    renderScreen()

    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa concluída recente")
    }, { timeout: 5000 })
  })

  it("trata awaiting_clarification e paused com mesma prioridade, ordenando por updatedAt", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa pausada recente", "paused", "2026-09-13T12:00:00Z"),
      tarefaFactory(2, "Tarefa aguardando antiga", "awaiting_clarification", "2026-09-10T12:00:00Z"),
    ])
    renderScreen()

    // Tarefa 1 (paused, mais recente) deve ser selecionada
    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa pausada recente")
    }, { timeout: 5000 })
  })
})

describe("OperationMapScreen — preservação de seleção em atualizações", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
    mockIsWideScreen = false
  })

  it("preserva seleção atual quando tarefa continua presente", async () => {
    mockIsWideScreen = true
    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa 1", "running", "2026-09-13T12:00:00Z"),
      tarefaFactory(2, "Tarefa 2", "paused", "2026-09-12T12:00:00Z"),
    ])
    renderScreen()

    // Aguarda seleção inicial (tarefa 2 - paused)
    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa 2")
    }, { timeout: 5000 })

    // Usuário clica na tarefa 1
    fireEvent.click(screen.getByTestId("operation-map-task-1"))

    // Aguarda tarefa 1 ser selecionada
    await waitFor(() => {
      const detailContent = screen.getByTestId("detail-content")
      expect(detailContent).toHaveTextContent("Tarefa 1")
    }, { timeout: 5000 })
  })
})

describe("OperationMapScreen — comportamento do detalhe em telas pequenas e largas", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
    mockIsWideScreen = false
  })

  it("em telas largas (>= 1280px), detalhe aparece como coluna lateral", async () => {
    mockIsWideScreen = true

    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa do mapa", "paused"),
    ])
    renderScreen()

    // Aguarda o painel de detalhe estar visível
    await waitFor(() => {
      const detailPanel = screen.getByTestId("detail-panel-wide")
      expect(detailPanel).toBeInTheDocument()
    })

    // O conteúdo do detalhe deve estar visível
    const detailContent = screen.getByTestId("detail-content")
    expect(detailContent).toBeInTheDocument()
  })

  it("em telas pequenas (< 1280px), detalhe não aparece como coluna lateral", async () => {
    mockIsWideScreen = false

    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa do mapa", "paused"),
    ])
    renderScreen()

    // Aguarda a tarefa estar visível
    await waitFor(() => {
      const task1Marker = screen.getByTestId("operation-map-task-1")
      expect(task1Marker).toBeInTheDocument()
    })

    // O painel de detalhe largo NÃO deve estar visível
    const detailPanel = screen.queryByTestId("detail-panel-wide")
    expect(detailPanel).not.toBeInTheDocument()
  })

  it("em telas pequenas, botão de reabrir detalhe aparece quando minimizado", async () => {
    mockIsWideScreen = false

    globalThis.__bundleMapa = bundleFalso([
      tarefaFactory(1, "Tarefa do mapa", "paused"),
    ])
    renderScreen()

    // Abre o detalhe clicando na tarefa
    await screen.findByTestId("operation-map-task-1")
    fireEvent.click(screen.getByTestId("operation-map-task-1"))

    // Aguarda o Drawer abrir
    await waitFor(() => {
      expect(screen.getByTestId("operation-task-drawer")).toBeInTheDocument()
    })

    // Clica no botão de minimizar
    const minimizeButton = screen.getByLabelText("Minimizar detalhe")
    fireEvent.click(minimizeButton)

    // Drawer deve fechar
    await waitFor(() => {
      expect(screen.queryByTestId("operation-task-drawer")).not.toBeInTheDocument()
    })

    // Botão de reabrir deve aparecer
    await waitFor(() => {
      const reopenButton = screen.getByTestId("btn-reopen-detail")
      expect(reopenButton).toBeInTheDocument()
    })

    // Clica no botão de reabrir
    fireEvent.click(screen.getByTestId("btn-reopen-detail"))

    // Drawer deve abrir novamente
    await waitFor(() => {
      expect(screen.getByTestId("operation-task-drawer")).toBeInTheDocument()
    })
  })
})
