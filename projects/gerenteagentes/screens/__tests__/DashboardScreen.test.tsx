// @vitest-environment jsdom
/**
 * Testes da DashboardScreen — visão do gerente de agentes (projetos + tarefas
 * recentes) consumindo os endpoints internos da plataforma
 * (/api/projetos_captados e /api/tarefas).
 *
 * Histórico: esta tela já foi testada quando fazia fetch para a API do motor
 * (http://api.tarefas.localhost) com cards de agente/atividade. O commit
 * ddd99a2 a converteu para os endpoints internos da plataforma com cards de
 * resumo (Projetos, Projetos Ativos, Total de Tarefas, Em Execução). Estes
 * testes validam o contrato ATUAL: loading, cards de resumo, lista de tarefas
 * recentes, estado vazio e alerta de erro.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

// Import direto para evitar problema de resolucao de modulo no vitest
import DashboardScreen from "../DashboardScreen"

const mockFetch = vi.fn()

function projetoFactory(id: number, nome: string, ativo = true) {
  return { id, nome, slug: `proj-${id}`, ativo } as const
}

function tarefaFactory(id: number, titulo: string, status: string, projetoId: number, agenteId: number) {
  return { id, titulo, status, projetoId, agenteId, createdAt: "2026-08-18T12:00:00Z" } as const
}

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

/** Mocka os dois fetches que a tela faz (projetos e tarefas), na ordem. */
function mockProjetosETarefas(projetos: unknown, tarefas: unknown) {
  mockFetch
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: projetos }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: tarefas }) })
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
    mockProjetosETarefas(
      [projetoFactory(1, "Projeto Alpha"), projetoFactory(2, "Projeto Beta")],
      [
        tarefaFactory(1, "Tarefa A", "completed", 1, 1),
        tarefaFactory(2, "Tarefa B", "running", 1, 1),
        tarefaFactory(3, "Tarefa C", "planned", 2, 1),
      ],
    )

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument()
    })

    // Asserts de URL: todas as chamadas devem ir para os endpoints internos
    const callUrls = mockFetch.mock.calls.map((c) => c[0])
    expect(callUrls).toContain("/api/projetos_captados")
    expect(callUrls).toContain("/api/tarefas")
    for (const url of callUrls) {
      expect(url).toMatch(/^\/api\/(projetos_captados|tarefas)$/)
    }

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument()
    expect(screen.getByText("Projetos")).toBeInTheDocument()
    expect(screen.getByText("Total de Tarefas")).toBeInTheDocument()
    expect(screen.getByText("Em Execução")).toBeInTheDocument()

    // Tarefas recentes aparecem
    expect(screen.getByText("Tarefa A")).toBeInTheDocument()
    expect(screen.getByText("Tarefa B")).toBeInTheDocument()
    expect(screen.getByText("Tarefa C")).toBeInTheDocument()
  })

  it("renderiza alert de erro quando a API falha", async () => {
    // Ambos os fetches rejeitam — o catch externo capta e exibe o alert
    mockFetch.mockRejectedValue(new Error("Erro simulado na API"))

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("error-alert")).toBeInTheDocument()
    })
    expect(screen.getByTestId("error-alert")).toHaveTextContent("Erro simulado na API")
  })

  it("renderiza estado vazio quando nao ha tarefas", async () => {
    mockProjetosETarefas([projetoFactory(1, "Projeto Alpha")], [])

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    })
  })

  it("renderiza card de resumo com contagens", async () => {
    mockProjetosETarefas(
      [projetoFactory(1, "Projeto Alpha"), projetoFactory(2, "Projeto Beta", false)],
      [tarefaFactory(1, "Tarefa A", "running", 1, 1), tarefaFactory(2, "Tarefa B", "completed", 1, 1)],
    )

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("resumo-projetos")).toBeInTheDocument()
      expect(screen.getByTestId("resumo-projetos-ativos")).toBeInTheDocument()
      expect(screen.getByTestId("resumo-total-tarefas")).toBeInTheDocument()
      expect(screen.getByTestId("resumo-running")).toBeInTheDocument()
    })

    // 2 projetos, 1 ativo
    expect(screen.getByTestId("resumo-projetos")).toHaveTextContent("2")
    expect(screen.getByTestId("resumo-projetos-ativos")).toHaveTextContent("1")
    expect(screen.getByTestId("resumo-total-tarefas")).toHaveTextContent("2")
    expect(screen.getByTestId("resumo-running")).toHaveTextContent("1")
  })

  it("renderiza tarefas recentes com chips de status", async () => {
    mockProjetosETarefas(
      [projetoFactory(1, "Alpha")],
      [tarefaFactory(1, "Tarefa ativa", "running", 1, 1), tarefaFactory(2, "Tarefa done", "completed", 1, 1)],
    )

    render(
      <BibliotecaThemeProvider>
        <DashboardScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("running-task-0")).toBeInTheDocument()
    })

    // Chips de status: "Em execução" e "Concluída"
    expect(screen.getByText("Em execução")).toBeInTheDocument()
    expect(screen.getByText("Concluída")).toBeInTheDocument()
  })
})
