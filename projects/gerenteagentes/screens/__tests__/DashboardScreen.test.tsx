// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider, clearCustomScreens } from "@biblioteca-global/ui"

// Import direto para evitar problema de resolucao de modulo no vitest
import DashboardScreen from "../DashboardScreen"

const mockFetch = vi.fn()

function projetoFactory(id: number, nome: string) {
  return { id, nome, slug: `projeto-${id}` }
}

function tarefaFactory(id: number, titulo: string, status: string, agenteId: number) {
  return { id, titulo, status, prioridade: 0, agenteId }
}

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

describe("DashboardScreen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renderiza loading antes dos dados carregarem", () => {
    // Mock que nunca resolve (trava no pending do fetch)
    mockFetch.mockReturnValue(new Promise(() => {}))

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )
    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument()
  })

  it("renderiza dashboard com projetos e tarefas", async () => {
    mockOk({ projects: [projetoFactory(1, "Projeto Alpha"), projetoFactory(2, "Projeto Beta")] })
    mockOk([tarefaFactory(1, "Tarefa A", "concluida", 1), tarefaFactory(2, "Tarefa B", "em_andamento", 1), tarefaFactory(3, "Tarefa C", "pendente", 1)])
    mockOk([tarefaFactory(4, "Tarefa D", "pendente", 2)])
    mockOk({ lastActivities: [] })

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument()
    })

    expect(screen.getByRole("heading", { name: "Dashboard do Gerente de Agentes" })).toBeInTheDocument()
    expect(screen.getByText(/Projetos/)).toBeInTheDocument()
    expect(screen.getByText(/Total de tarefas/)).toBeInTheDocument()
    expect(screen.getByText(/Em execucao/)).toBeInTheDocument()
  })

  it("renderiza alert de erro quando a API falha", async () => {
    // Todas as chamadas falham — o catch externo capta e exibe o alert
    mockFetch.mockRejectedValue(new Error("Erro simulado na API"))

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("error-alert")).toBeInTheDocument()
    })
  })

  it("renderiza empty state quando nao ha agentes", async () => {
    mockOk({ projects: [] })
    mockOk({ lastActivities: [] })

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    })
  })

  it("renderiza card de agente com progresso", async () => {
    mockOk({ projects: [projetoFactory(1, "Projeto Alpha")] })
    mockOk([tarefaFactory(1, "Tarefa A", "em_andamento", 1), tarefaFactory(2, "Tarefa B", "pendente", 1)])
    mockOk({ lastActivities: [] })

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("card-agente")).toBeInTheDocument()
    })
  })

  it("renderiza tarefas em execucao com chips de status", async () => {
    mockOk({ projects: [projetoFactory(1, "Alpha")] })
    mockOk([tarefaFactory(1, "Tarefa ativa", "em_andamento", 1)])
    mockOk({ lastActivities: [] })

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("running-task-0")).toBeInTheDocument()
      expect(screen.getByTestId("task-status-chip-1")).toHaveTextContent("Em andamento")
    })
  })
})
