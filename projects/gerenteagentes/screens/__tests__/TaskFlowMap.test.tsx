// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import TaskFlowMap, { type FlowTask, type ProjetoInfo, type FiltrosMapa } from "../TaskFlowMap"

const tarefas: FlowTask[] = [
  { id: 766, titulo: "Registry de telas", status: "running", projetoId: 1 },
  { id: 767, titulo: "Documentar API", status: "ready", projetoId: 1 },
  { id: 768, titulo: "Corrigir testes", status: "motor_fix", projetoId: 1 },
  { id: 769, titulo: "Publicar versão", status: "completed", projetoId: 1 },
]

const projetos: ProjetoInfo[] = [
  { id: 1, nome: "Projeto Alpha" },
  { id: 2, nome: "Projeto Beta" },
]

function view(items = tarefas, onSelectTask = vi.fn(), filtros?: FiltrosMapa, onFiltrosChange = vi.fn()) {
  return render(
    <BibliotecaThemeProvider>
      <TaskFlowMap
        tarefas={items}
        selectedTaskId=""
        onSelectTask={onSelectTask}
        projetos={projetos}
        filtros={filtros}
        onFiltrosChange={onFiltrosChange}
      />
    </BibliotecaThemeProvider>
  )
}

describe("TaskFlowMap", () => {
  it("mostra a quantidade de tarefas em cada estação e sinaliza a IA ativa", () => {
    view()
    expect(screen.getByTestId("flow-count-running")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-ready")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-repair")).toHaveTextContent("1")
    expect(screen.getAllByLabelText("IA trabalhando")).toHaveLength(2)
  })

  it("abre a tarefa ao clicar em sua ficha", async () => {
    const onSelectTask = vi.fn()
    view(tarefas, onSelectTask)
    await userEvent.click(screen.getByTestId("flow-task-767"))
    expect(onSelectTask).toHaveBeenCalledWith(767)
  })

  it("exibe a descrição correta ao passar o mouse no ícone da tarefa", async () => {
    view([
      { id: 770, titulo: "Primeira tarefa", descricao: "Descrição da primeira tarefa", status: "ready", projetoId: 1 },
      { id: 771, titulo: "Segunda tarefa", descricao: "Descrição da segunda tarefa", status: "running", projetoId: 1 },
    ])

    await userEvent.hover(screen.getByTestId("flow-task-description-770"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Descrição da primeira tarefa")
    await userEvent.unhover(screen.getByTestId("flow-task-description-770"))
    await userEvent.hover(screen.getByTestId("flow-task-description-771"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Descrição da segunda tarefa")
  })

  it("usa um fallback seguro quando a tarefa não tem descrição", async () => {
    view([
      { id: 772, titulo: "Sem descrição", descricao: null, status: "ready", projetoId: 1 },
      { id: 773, titulo: "Descrição em branco", descricao: "   ", status: "running", projetoId: 1 },
    ])

    await userEvent.hover(screen.getByTestId("flow-task-description-772"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Tarefa sem descrição")
    await userEvent.unhover(screen.getByTestId("flow-task-description-772"))
    await userEvent.hover(screen.getByTestId("flow-task-description-773"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Tarefa sem descrição")
  })

  it("mantém um ícone de descrição em cada cartão visível de estações diferentes", () => {
    view([
      { id: 774, titulo: "Na fila", descricao: "Detalhes da fila", status: "ready", projetoId: 1 },
      { id: 775, titulo: "Em execução", descricao: "Detalhes da execução", status: "running", projetoId: 1 },
      { id: 776, titulo: "Concluída", descricao: "Detalhes da entrega", status: "completed", projetoId: 1 },
    ])

    expect(screen.getAllByTestId(/^flow-task-description-/)).toHaveLength(3)
    expect(screen.getByTestId("flow-task-774")).toBeInTheDocument()
    expect(screen.getByTestId("flow-task-775")).toBeInTheDocument()
    expect(screen.getByTestId("flow-task-776")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-ready")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-completed")).toBeInTheDocument()
  })

  it("destaca uma transição quando o status muda", () => {
    const rendered = view([{ id: 766, titulo: "Registry", status: "ready", projetoId: 1 }])
    rendered.rerender(<BibliotecaThemeProvider><TaskFlowMap tarefas={[{ id: 766, titulo: "Registry", status: "running", projetoId: 1 }]} selectedTaskId="" onSelectTask={vi.fn()} /></BibliotecaThemeProvider>)
    expect(screen.getByTestId("flow-movement-766")).toHaveTextContent("Pronta → Em execução")
  })

  it("mostra a atividade do Motor durante verificação e deploy", () => {
    render(<BibliotecaThemeProvider><TaskFlowMap tarefas={tarefas} selectedTaskId="" onSelectTask={vi.fn()} motorActivities={[
      { taskId: "task-p2-770", phase: "verify" },
      { taskId: "task-p2-771", phase: "deploy" },
    ]} /></BibliotecaThemeProvider>)
    expect(screen.getByTestId("flow-motor-activity")).toHaveTextContent("verificando task-p2-770")
    expect(screen.getByTestId("flow-motor-activity")).toHaveTextContent("deployando task-p2-771")
  })
})

describe("TaskFlowMap — Filtros integrados", () => {
  it("renderiza a barra de filtro no topo com busca, chips de status, projeto e prioridade", () => {
    view()
    expect(screen.getByTestId("map-filter-bar")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-busca")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-chip-em-execucao")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-chip-bloqueadas")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-chip-concluidas")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-projeto")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-prioridade-alta")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-prioridade-media")).toBeInTheDocument()
    expect(screen.getByTestId("map-filter-prioridade-baixa")).toBeInTheDocument()
  })

  it("exibe o contador 'X de Y tarefas'", () => {
    view()
    expect(screen.getByTestId("map-filter-contador")).toHaveTextContent("4 de 4 tarefas")
  })

  it("filtra tarefas ao clicar no chip 'Em execução'", async () => {
    const onFiltrosChange = vi.fn()
    view(tarefas, vi.fn(), { busca: "", status: [], projetoId: "", prioridade: "" }, onFiltrosChange)

    await userEvent.click(screen.getByTestId("map-filter-chip-em-execucao"))
    expect(onFiltrosChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["em-execucao"] })
    )
  })

  it("filtra tarefas ao clicar no chip 'Bloqueadas'", async () => {
    const onFiltrosChange = vi.fn()
    view(tarefas, vi.fn(), { busca: "", status: [], projetoId: "", prioridade: "" }, onFiltrosChange)

    await userEvent.click(screen.getByTestId("map-filter-chip-bloqueadas"))
    expect(onFiltrosChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["bloqueadas"] })
    )
  })

  it("filtra tarefas ao clicar no chip 'Concluídas'", async () => {
    const onFiltrosChange = vi.fn()
    view(tarefas, vi.fn(), { busca: "", status: [], projetoId: "", prioridade: "" }, onFiltrosChange)

    await userEvent.click(screen.getByTestId("map-filter-chip-concluidas"))
    expect(onFiltrosChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["concluidas"] })
    )
  })

  it("atualiza o contador quando há filtros ativos", () => {
    const filtrosAtivos: FiltrosMapa = {
      busca: "",
      status: ["em-execucao"],
      projetoId: "",
      prioridade: "",
    }
    view(tarefas, vi.fn(), filtrosAtivos)
    // running + motor_fix = 2 tarefas
    expect(screen.getByTestId("map-filter-contador")).toHaveTextContent("2 de 4 tarefas")
  })

  it("exibe o botão 'Limpar filtros' quando há filtros ativos", () => {
    const filtrosAtivos: FiltrosMapa = {
      busca: "teste",
      status: [],
      projetoId: "",
      prioridade: "",
    }
    view(tarefas, vi.fn(), filtrosAtivos)
    expect(screen.getByTestId("map-filter-limpar")).toBeInTheDocument()
  })

  it("não exibe o botão 'Limpar filtros' quando não há filtros ativos", () => {
    const filtrosLimpos: FiltrosMapa = {
      busca: "",
      status: [],
      projetoId: "",
      prioridade: "",
    }
    view(tarefas, vi.fn(), filtrosLimpos)
    expect(screen.queryByTestId("map-filter-limpar")).not.toBeInTheDocument()
  })

  it("chama onFiltrosChange com filtros zerados ao clicar em 'Limpar filtros'", async () => {
    const onFiltrosChange = vi.fn()
    const filtrosAtivos: FiltrosMapa = {
      busca: "teste",
      status: ["em-execucao"],
      projetoId: 1,
      prioridade: "alta",
    }
    view(tarefas, vi.fn(), filtrosAtivos, onFiltrosChange)

    await userEvent.click(screen.getByTestId("map-filter-limpar"))
    expect(onFiltrosChange).toHaveBeenCalledWith({
      busca: "",
      status: [],
      projetoId: "",
      prioridade: "",
    })
  })

  it("filtra por prioridade ao clicar no chip de prioridade", async () => {
    const onFiltrosChange = vi.fn()
    view(tarefas, vi.fn(), { busca: "", status: [], projetoId: "", prioridade: "" }, onFiltrosChange)

    await userEvent.click(screen.getByTestId("map-filter-prioridade-alta"))
    expect(onFiltrosChange).toHaveBeenCalledWith(
      expect.objectContaining({ prioridade: "alta" })
    )
  })
})

describe("TaskFlowMap — Tecla Esc", () => {
  it("limpa todos os filtros ao pressionar Esc", async () => {
    const onFiltrosChange = vi.fn()
    const filtrosAtivos: FiltrosMapa = {
      busca: "teste",
      status: ["em-execucao"],
      projetoId: 1,
      prioridade: "alta",
    }
    view(tarefas, vi.fn(), filtrosAtivos, onFiltrosChange)

    await userEvent.keyboard("{Escape}")
    expect(onFiltrosChange).toHaveBeenCalledWith({
      busca: "",
      status: [],
      projetoId: "",
      prioridade: "",
    })
  })

  it("não chama onFiltrosChange ao pressionar Esc quando não há filtros ativos", async () => {
    const onFiltrosChange = vi.fn()
    const filtrosLimpos: FiltrosMapa = {
      busca: "",
      status: [],
      projetoId: "",
      prioridade: "",
    }
    view(tarefas, vi.fn(), filtrosLimpos, onFiltrosChange)

    await userEvent.keyboard("{Escape}")
    expect(onFiltrosChange).not.toHaveBeenCalled()
  })
})

describe("TaskFlowMap — Legenda interativa", () => {
  it("renderiza a legenda no rodapé com os 4 tones", () => {
    view()
    expect(screen.getByTestId("map-legend")).toBeInTheDocument()
    expect(screen.getByTestId("map-legend-success")).toBeInTheDocument()
    expect(screen.getByTestId("map-legend-warning")).toBeInTheDocument()
    expect(screen.getByTestId("map-legend-danger")).toBeInTheDocument()
    expect(screen.getByTestId("map-legend-active")).toBeInTheDocument()
  })

  it("destaca tarefas do tone ao clicar na legenda", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-legend-success"))
    // O chip deve ficar com variant filled (color primary)
    expect(screen.getByTestId("map-legend-success")).toHaveClass("MuiChip-colorPrimary")
  })

  it("remove o destaque ao clicar novamente na mesma legenda", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-legend-success"))
    expect(screen.getByTestId("map-legend-success")).toHaveClass("MuiChip-colorPrimary")

    await userEvent.click(screen.getByTestId("map-legend-success"))
    expect(screen.getByTestId("map-legend-success")).not.toHaveClass("MuiChip-colorPrimary")
  })

  it("mostra emojis na legenda", () => {
    view()
    expect(screen.getByTestId("map-legend-success")).toHaveTextContent("🟢")
    expect(screen.getByTestId("map-legend-warning")).toHaveTextContent("🟡")
    expect(screen.getByTestId("map-legend-danger")).toHaveTextContent("🔴")
    expect(screen.getByTestId("map-legend-active")).toHaveTextContent("🔵")
  })
})
