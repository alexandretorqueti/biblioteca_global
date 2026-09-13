// @vitest-environment jsdom
/**
 * Testes do mapa "Mission Control" (OperationMapCanvas).
 *
 * Cobrem a equivalência funcional exigida pela refatoração:
 * contadores, densidade/carregamento incremental, filtros, seleção,
 * exceções, intervenção humana, workers e modo desconectado.
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import OperationMapCanvas from "../OperationMapCanvas"
import type { FlowTask } from "../TaskFlowMap"

const projetos = [
  { id: 1, nome: "Biblioteca Global" },
  { id: 2, nome: "TaQui" },
]

function makeTasks(count: number, status: string, prefix = 800): FlowTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: prefix + index,
    titulo: `Tarefa ${prefix + index}`,
    status,
    projetoId: 1,
  }))
}

function view(tasks: FlowTask[], props: Partial<React.ComponentProps<typeof OperationMapCanvas>> = {}) {
  const onSelectTask = props.onSelectTask ?? vi.fn()
  render(
    <BibliotecaThemeProvider>
      <OperationMapCanvas
        tarefas={tasks}
        selectedTaskId=""
        projetos={projetos}
        onSelectTask={onSelectTask}
        {...props}
      />
    </BibliotecaThemeProvider>,
  )
  return { onSelectTask }
}

describe("OperationMapCanvas", () => {
  it("mostra as estações do fluxo com contadores e sinaliza a IA trabalhando", () => {
    view([
      ...makeTasks(2, "running", 810),
      ...makeTasks(1, "ready", 820),
      ...makeTasks(3, "deployed", 830),
    ])

    expect(screen.getByTestId("operation-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("operation-count-running")).toHaveTextContent("2")
    expect(screen.getByTestId("operation-count-ready")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-count-deployed")).toHaveTextContent("3")
    // Estação ativa (IA trabalhando) precisa deixar isso explícito sem depender só de cor
    expect(screen.getByLabelText("IA trabalhando")).toBeInTheDocument()
  })

  it("destaca intervenção humana necessária e abre a tarefa correspondente", async () => {
    const { onSelectTask } = view([
      { id: 901, titulo: "Precisa de resposta", status: "awaiting_clarification", projetoId: 1 },
      ...makeTasks(1, "running", 902),
    ])

    const banner = screen.getByTestId("operation-intervention-banner")
    expect(banner).toHaveTextContent("1 tarefa precisa de você")

    await userEvent.click(within(banner).getByRole("button", { name: /Abrir #901/ }))
    expect(onSelectTask).toHaveBeenCalledWith(901)
  })

  it("mantém exceções acessíveis quando zeradas (discretas) e destacadas quando há ocorrências", () => {
    view([...makeTasks(1, "running", 910), { id: 920, titulo: "Bloqueada", status: "blocked", projetoId: 1 }])
    expect(screen.getByTestId("operation-count-attention")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-station-attention")).toHaveTextContent("intervenção")
    expect(screen.getByTestId("operation-count-waiting")).toHaveTextContent("0")
  })

  it("carrega incrementalmente até 5 e expande as demais da mesma estação", async () => {
    view(makeTasks(6, "running", 930))

    expect(screen.getByTestId("operation-count-running")).toHaveTextContent("6")
    expect(screen.getByTestId("operation-map-task-930")).toBeInTheDocument()
    expect(screen.queryByTestId("operation-map-task-935")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("operation-more-running"))
    expect(screen.getByTestId("operation-map-task-935")).toBeInTheDocument()
  })

  it("representa volume de deployadas por densidade e dá acesso a todas", async () => {
    const deployed = makeTasks(30, "deployed", 1000)
    view(deployed)

    const resumo = screen.getByTestId("operation-deployed-summary")
    expect(screen.getByTestId("operation-count-deployed")).toHaveTextContent("30")
    expect(resumo).toHaveTextContent("em produção")
    expect(resumo).toHaveTextContent("#1000")
    expect(screen.getByTestId("operation-density-deployed")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("operation-deployed-see-all"))
    const lista = screen.getByTestId("operation-list-view")
    expect(within(lista).getAllByTestId(/operation-list-task-/)).toHaveLength(30)
    expect(screen.getByText(/Estação: Deployadas/)).toBeInTheDocument()
  })

  it("abre o detalhe ao clicar em um marcador", async () => {
    const { onSelectTask } = view(makeTasks(2, "running", 940))
    await userEvent.click(screen.getByTestId("operation-map-task-941"))
    expect(onSelectTask).toHaveBeenCalledWith(941)
  })

  it("aplica filtro de busca ao mapa", async () => {
    view([
      { id: 950, titulo: "Limpeza de Concluídos", status: "running", projetoId: 1 },
      { id: 951, titulo: "Outra coisa", status: "running", projetoId: 1 },
    ])

    await userEvent.type(screen.getByTestId("operation-filter-search"), "#950")
    expect(screen.getByTestId("operation-count-running")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-map-task-950")).toBeInTheDocument()
    expect(screen.queryByTestId("operation-map-task-951")).not.toBeInTheDocument()
    expect(screen.getByTestId("operation-active-filters")).toBeInTheDocument()
  })

  it("exibe workers ativos com detalhamento em popover", async () => {
    view(makeTasks(1, "running", 960), {
      activeWorkers: 2,
      maxWorkers: 4,
      workers: [
        { executionId: "e1", taskId: "819", projectSlug: "biblioteca-global", phase: "execute", executionPhase: "verify", ageMs: 300000 },
        { executionId: "e2", taskId: "824", projectSlug: "global", phase: "execute", executionPhase: "analyze", ageMs: 60000 },
      ],
    })

    const indicador = screen.getByTestId("operation-workers-indicator")
    expect(indicador).toHaveTextContent("2 workers")

    await userEvent.click(indicador)
    expect(screen.getByText(/biblioteca-global · #819/)).toBeInTheDocument()
    expect(screen.getByText(/global · #824/)).toBeInTheDocument()
    expect(screen.getByText(/Workers \(2\/4\)/)).toBeInTheDocument()
  })

  it("mostra a lista de tarefas e o feed de atividade", async () => {
    view([
      { id: 970, titulo: "Rascunhos", status: "deployed", projetoId: 1 },
      { id: 971, titulo: "Alteração nos quadros", status: "running", projetoId: 2 },
    ])

    await userEvent.click(screen.getByRole("tab", { name: /Lista/ }))
    const lista = screen.getByTestId("operation-list-view")
    expect(within(lista).getByTestId("operation-list-task-970")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: /Atividade/ }))
    const atividade = screen.getByTestId("operation-activity-view")
    expect(within(atividade).getByTestId("operation-activity-task-971")).toBeInTheDocument()
  })

  it("sinaliza reconexão do tempo real", () => {
    view(makeTasks(1, "running", 980), { aoVivo: false })
    expect(screen.getByTestId("operation-realtime-warning")).toBeInTheDocument()
  })
})
