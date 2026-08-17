// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider, clearCustomScreens, getCustomScreen, registerCustomScreens } from "@biblioteca-global/ui"
import { registrarTelasCustom } from "../../../../apps/web/src/project/registry/customScreens"

// Mock do fetch para evitar chamadas HTTP reais
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function projetoFactory(id: number, nome: string): unknown {
  return { id, nome, slug: `projeto-${id}` }
}

function tarefaFactory(
  id: number,
  titulo: string,
  status: "pendente" | "em_andamento" | "concluida" | "cancelada",
  agenteId: number,
): unknown {
  return { id, titulo, status, prioridade: 0, agenteId }
}

/** Mock fetch que resolve um dado arbitrário. */
function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

/** Mock fetch que rejeita com erro. */
function mockFail() {
  mockFetch.mockRejectedValueOnce(new Error("Network error"))
}

/* ------------------------------------------------------------------ */
/*  Testes                                                            */
/* ------------------------------------------------------------------ */

describe("DashboardScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCustomScreens()
    registrarTelasCustom()
    // Mock default: projetos + tarefas vazias
    mockOk({ projects: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("registra o screen no registry", () => {
    const Dashboard = getCustomScreen("gerenteagentes-dashboard")
    expect(Dashboard).toBeDefined()
  })

  it("renderiza loading antes dos dados carregarem", () => {
    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
      </BibliotecaThemeProvider>,
    )
    expect(screen.getByTestId("loading-spinner")).toBeInTheDocument()
  })

  it("renderiza dashboard com projetos e tarefas", async () => {
    mockOk({
      projects: [
        projetoFactory(1, "Projeto Alpha"),
        projetoFactory(2, "Projeto Beta"),
      ],
    })
    mockOk([
      tarefaFactory(1, "Tarefa A", "concluida", 1),
      tarefaFactory(2, "Tarefa B", "em_andamento", 1),
      tarefaFactory(3, "Tarefa C", "pendente", 1),
    ])
    mockOk([
      tarefaFactory(4, "Tarefa D", "pendente", 2),
    ])

    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
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
    mockFail()

    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("error-alert")).toBeInTheDocument()
    })
  })

  it("renderiza empty state quando nao ha agentes", async () => {
    mockOk({ projects: [] })

    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument()
      expect(screen.getByText(/Nenhum agente encontrado/)).toBeInTheDocument()
    })
  })

  it("renderiza card de agente com progresso", async () => {
    mockOk({ projects: [projetoFactory(1, "Projeto Alpha")] })
    mockOk([
      tarefaFactory(1, "Tarefa A", "em_andamento", 1),
      tarefaFactory(2, "Tarefa B", "pendente", 1),
    ])

    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("card-agente")).toBeInTheDocument()
    })
  })

  it("renderiza tarefas em execucao com chips de status", async () => {
    mockOk({ projects: [projetoFactory(1, "Alpha")] })
    mockOk([
      tarefaFactory(1, "Tarefa ativa", "em_andamento", 1),
    ])

    render(
      <BibliotecaThemeProvider>
        {getCustomScreen("gerenteagentes-dashboard")!()}
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("running-task-0")).toBeInTheDocument()
      const chip = screen.getByTestId("task-status-chip-1")
      expect(chip).toHaveTextContent("Em andamento")
    })
  })
})
