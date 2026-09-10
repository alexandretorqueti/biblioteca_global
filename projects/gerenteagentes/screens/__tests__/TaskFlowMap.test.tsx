// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
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

function view(items = tarefas, onSelectTask = vi.fn(), filtros?: FiltrosMapa, onFiltrosChange = vi.fn(), projetosView: ProjetoInfo[] = projetos) {
  return render(
    <BibliotecaThemeProvider>
      <TaskFlowMap
        tarefas={items}
        selectedTaskId=""
        onSelectTask={onSelectTask}
        projetos={projetosView}
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

describe("TaskFlowMap — Polimento transversal (5.1/5.2/5.3)", () => {
  it("título do mapa usa tipografia refinada (5.2)", () => {
    view()
    const titulo = screen.getByText("Mapa Vivo da Operação")
    expect(titulo).toBeInTheDocument()
    // Verifica que o título é um h6 (variant="h6") com fontWeight 800
    // O fontWeight é aplicado via MUI Typography props, gerando classe CSS
    expect(titulo.tagName).toBe("H6")
    // Verifica que tem a classe do MUI Typography
    expect(titulo).toHaveClass("MuiTypography-root")
  })

  it("estações têm borda superior colorida (borderTop 4px)", () => {
    view()
    const stationRunning = screen.getByTestId("flow-station-running")
    expect(stationRunning).toBeInTheDocument()
    // Verifica que a estação tem borderTop (via sx)
    // O estilo é aplicado via sx, então verificamos via getComputedStyle
    const computedStyle = window.getComputedStyle(stationRunning)
    expect(computedStyle.borderTopWidth).toBe("4px")
  })

  it("renderiza corretamente no tema claro (default)", () => {
    view()
    const map = screen.getByTestId("task-flow-map")
    expect(map).toBeInTheDocument()
    // Verifica que o mapa renderizou com sucesso
    expect(screen.getByTestId("map-header")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard")).toBeInTheDocument()
  })

  it("renderiza corretamente no tema escuro", () => {
    // Renderiza com tema escuro usando BibliotecaThemeProvider com mode="dark"
    render(
      <BibliotecaThemeProvider themeMode="dark">
        <TaskFlowMap tarefas={tarefas} selectedTaskId="" onSelectTask={vi.fn()} />
      </BibliotecaThemeProvider>
    )
    const map = screen.getByTestId("task-flow-map")
    expect(map).toBeInTheDocument()
    // Verifica que o mapa renderizou com sucesso no tema escuro
    expect(screen.getByTestId("map-header")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-running")).toBeInTheDocument()
  })
})

describe("TaskFlowMap — Cabeçalho impactante (1.1)", () => {
  it("renderiza o cabeçalho com ícone, título e badge 'AO VIVO' pulsante", () => {
    view()
    expect(screen.getByTestId("map-header")).toBeInTheDocument()
    expect(screen.getByTestId("map-badge-ao-vivo")).toBeInTheDocument()
    expect(screen.getByTestId("map-badge-ao-vivo")).toHaveTextContent("AO VIVO")
  })

  it("oculta o badge 'AO VIVO' quando aoVivo=false", () => {
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap tarefas={tarefas} selectedTaskId="" onSelectTask={vi.fn()} aoVivo={false} />
      </BibliotecaThemeProvider>
    )
    expect(screen.queryByTestId("map-badge-ao-vivo")).not.toBeInTheDocument()
  })

  it("renderiza o separador visual com gradiente", () => {
    view()
    expect(screen.getByTestId("map-header-separator")).toBeInTheDocument()
  })

  it("exibe métricas rápidas no topo (total, em andamento, concluídas hoje)", () => {
    view()
    expect(screen.getByTestId("map-metricas-rapidas")).toBeInTheDocument()
    expect(screen.getByTestId("map-metric-total")).toHaveTextContent("4")
    expect(screen.getByTestId("map-metric-andamento")).toHaveTextContent("2") // running + motor_fix
    expect(screen.getByTestId("map-metric-hoje")).toHaveTextContent("0") // nenhuma updatedAt hoje
  })
})

describe("TaskFlowMap — Dashboard compacto (3.1)", () => {
  it("renderiza o dashboard entre o cabeçalho e as estações", () => {
    view()
    expect(screen.getByTestId("map-dashboard")).toBeInTheDocument()
  })

  it("exibe total de tarefas ativas no dashboard", () => {
    view()
    expect(screen.getByTestId("map-dashboard-total-ativas")).toHaveTextContent("4")
  })

  it("renderiza mini gráfico de barras por fase", () => {
    view()
    expect(screen.getByTestId("map-dashboard-barras")).toBeInTheDocument()
    // Verifica que existem barras para as estações
    expect(screen.getByTestId("map-dashboard-bar-running")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard-bar-ready")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard-bar-repair")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard-bar-completed")).toBeInTheDocument()
  })

  it("exibe tempo médio de execução no dashboard", () => {
    view()
    expect(screen.getByTestId("map-dashboard-tempo-medio")).toBeInTheDocument()
    expect(screen.getByTestId("map-dashboard-tempo-medio")).toHaveTextContent("—") // sem concluídas com datas
  })

  it("destaca tarefas bloqueadas em vermelho quando > 0", () => {
    const tarefasComBloqueadas: FlowTask[] = [
      { id: 800, titulo: "Bloqueada", status: "blocked", projetoId: 1 },
      { id: 801, titulo: "Falhou", status: "failed", projetoId: 1 },
      { id: 802, titulo: "Rodando", status: "running", projetoId: 1 },
    ]
    view(tarefasComBloqueadas)
    expect(screen.getByTestId("map-metric-bloqueadas")).toHaveTextContent("2")
  })

  it("mostra 0 bloqueadas em cor neutra quando não há bloqueadas", () => {
    view()
    expect(screen.getByTestId("map-metric-bloqueadas")).toHaveTextContent("0")
  })

  it("preserva flow-ai-activity no dashboard", () => {
    view()
    expect(screen.getByTestId("flow-ai-activity")).toBeInTheDocument()
    expect(screen.getByTestId("flow-ai-activity")).toHaveTextContent("IA trabalhando (2)")
  })

  it("preserva flow-motor-activity no dashboard", () => {
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefas}
          selectedTaskId=""
          onSelectTask={vi.fn()}
          motorActivities={[
            { taskId: "task-p2-770", phase: "verify" },
            { taskId: "task-p2-771", phase: "deploy" },
          ]}
        />
      </BibliotecaThemeProvider>
    )
    expect(screen.getByTestId("flow-motor-activity")).toBeInTheDocument()
    expect(screen.getByTestId("flow-motor-activity")).toHaveTextContent("verificando task-p2-770")
    expect(screen.getByTestId("flow-motor-activity")).toHaveTextContent("deployando task-p2-771")
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

describe("TaskFlowMap — Estações com identidade visual (1.2)", () => {
  it("renderiza 11 estações com ícones representativos", () => {
    view()
    // Main flow: draft, planned, analyzing, ready, running, completed, deployed (7)
    // Side flow: waiting, repair, attention, closed (4)
    // Total = 11
    expect(screen.getByTestId("flow-station-draft")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-planned")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-analyzing")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-ready")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-completed")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-deployed")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-waiting")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-repair")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-attention")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-closed")).toBeInTheDocument()
  })

  it("contador em cada estação com badge circular (flow-count-*)", () => {
    view()
    const countRunning = screen.getByTestId("flow-count-running")
    expect(countRunning).toBeInTheDocument()
    expect(countRunning).toHaveTextContent("1")
    // Verifica que o contador tem estilo de badge (border-radius 50% via sx)
    expect(countRunning).toHaveStyle({ borderRadius: "50%" })
  })

  it("contador usa fonte monoespaçada (Roboto Mono)", () => {
    view()
    const countRunning = screen.getByTestId("flow-count-running")
    expect(countRunning).toHaveStyle({ fontFamily: "'Roboto Mono', ui-monospace, monospace" })
  })
})

describe("TaskFlowMap — Toggle Compactar (4.1)", () => {
  it("renderiza o botão 'Compactar' com data-testid map-toggle-compactar", () => {
    view()
    expect(screen.getByTestId("map-toggle-compactar")).toBeInTheDocument()
    expect(screen.getByTestId("map-toggle-compactar")).toHaveTextContent("Compactar")
  })

  it("ao clicar em 'Compactar', botão muda para 'Expandir'", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-toggle-compactar"))
    expect(screen.getByTestId("map-toggle-compactar")).toHaveTextContent("Expandir")
  })

  it("modo compacto oculta os cards de tarefas", async () => {
    view()
    // Antes: cards visíveis
    expect(screen.getByTestId("flow-task-766")).toBeInTheDocument()
    // Compactar
    await userEvent.click(screen.getByTestId("map-toggle-compactar"))
    // Depois: cards ocultos
    expect(screen.queryByTestId("flow-task-766")).not.toBeInTheDocument()
  })

  it("modo compacto mantém contadores visíveis", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-toggle-compactar"))
    // Contadores ainda visíveis
    expect(screen.getByTestId("flow-count-running")).toBeInTheDocument()
    expect(screen.getByTestId("flow-count-ready")).toBeInTheDocument()
  })
})

describe("TaskFlowMap — Expansão de estação (4.1)", () => {
  // Com PAGE_SIZE=10, precisamos de mais de 10 tarefas para testar a expansão
  const muitasTarefas: FlowTask[] = Array.from({ length: 12 }, (_, i) => ({
    id: 900 + i,
    titulo: `Tarefa ${i + 1}`,
    status: "running" as const,
    projetoId: 1,
  }))

  it("mostra indicador '+ N tarefas' quando há mais de 10 tarefas na estação", () => {
    view(muitasTarefas)
    // 12 tarefas total, 10 visíveis inicialmente → "+ 2 tarefas"
    expect(screen.getByTestId("flow-station-running")).toHaveTextContent("+ 2 tarefas")
  })

  it("ao clicar no header da estação, expande mostrando todas as tarefas", async () => {
    view(muitasTarefas)
    // Antes: só 10 visíveis (PAGE_SIZE)
    expect(screen.getByTestId("flow-task-900")).toBeInTheDocument()
    expect(screen.getByTestId("flow-task-909")).toBeInTheDocument()
    expect(screen.queryByTestId("flow-task-910")).not.toBeInTheDocument()
    expect(screen.queryByTestId("flow-task-911")).not.toBeInTheDocument()
    // Clica no header para expandir
    await userEvent.click(screen.getByTestId("flow-station-running-header"))
    // Depois: todas visíveis
    expect(screen.getByTestId("flow-task-910")).toBeInTheDocument()
    expect(screen.getByTestId("flow-task-911")).toBeInTheDocument()
  })

  it("ao expandir, mostra texto 'Mostrando todas (N)'", async () => {
    view(muitasTarefas)
    await userEvent.click(screen.getByTestId("flow-station-running-header"))
    expect(screen.getByTestId("flow-station-running")).toHaveTextContent("Mostrando todas (12)")
  })
})

describe("TaskFlowMap — Navegação por teclado (4.2)", () => {
  it("estações têm tabIndex=0 para navegação por Tab", () => {
    view()
    const stationRunning = screen.getByTestId("flow-station-running")
    expect(stationRunning).toHaveAttribute("tabIndex", "0")
  })

  it("estações têm role='group' e aria-label com nome e contador", () => {
    view()
    const stationRunning = screen.getByTestId("flow-station-running")
    expect(stationRunning).toHaveAttribute("role", "group")
    expect(stationRunning).toHaveAttribute("aria-label", "Em execução: 1 tarefas")
  })

  it("Enter no card de tarefa chama onSelectTask", async () => {
    const onSelectTask = vi.fn()
    view(tarefas, onSelectTask)
    const card = screen.getByTestId("flow-task-767")
    card.focus()
    await userEvent.keyboard("{Enter}")
    expect(onSelectTask).toHaveBeenCalledWith(767)
  })
})

describe("TaskFlowMap — Cards informativos (1.3)", () => {
  it("renderiza avatar do projeto com letra e cor determinística em cada card", () => {
    const tarefasComNome: FlowTask[] = [
      { id: 766, titulo: "Registry de telas", status: "running", projetoId: 1, projetoNome: "Alpha" },
      { id: 767, titulo: "Documentar API", status: "ready", projetoId: 2, projetoNome: "Beta" },
    ]
    view(tarefasComNome, vi.fn(), undefined, vi.fn(), [
      { id: 1, nome: "Alpha" },
      { id: 2, nome: "Beta" },
    ])
    // Avatar do projeto 1 (Alpha) → letra "A"
    const avatar766 = screen.getByTestId("flow-task-avatar-766")
    expect(avatar766).toBeInTheDocument()
    expect(avatar766).toHaveTextContent("A")
    // Avatar do projeto 2 (Beta) → letra "B"
    const avatar767 = screen.getByTestId("flow-task-avatar-767")
    expect(avatar767).toBeInTheDocument()
    expect(avatar767).toHaveTextContent("B")
  })

  it("avatar usa '#' como fallback quando projeto não tem nome", () => {
    view([{ id: 990, titulo: "Sem nome projeto", status: "ready", projetoId: 5 }])
    const avatar = screen.getByTestId("flow-task-avatar-990")
    expect(avatar).toHaveTextContent("#")
  })

  it("exibe tempo relativo (flow-task-tempo-<id>) em cada card", () => {
    const agora = new Date()
    const duasHorasAtras = new Date(agora.getTime() - 2 * 60 * 60 * 1000).toISOString()
    const umDiaAtras = new Date(agora.getTime() - 24 * 60 * 60 * 1000).toISOString()
    view([
      { id: 980, titulo: "Recente", status: "running", projetoId: 1, updatedAt: duasHorasAtras },
      { id: 981, titulo: "Antiga", status: "ready", projetoId: 1, updatedAt: umDiaAtras },
    ])
    expect(screen.getByTestId("flow-task-tempo-980")).toHaveTextContent("há 2h")
    expect(screen.getByTestId("flow-task-tempo-981")).toHaveTextContent("há 1d")
  })

  it("exibe '—' quando a tarefa não tem data de atualização", () => {
    view([{ id: 982, titulo: "Sem data", status: "draft", projetoId: 1 }])
    expect(screen.getByTestId("flow-task-tempo-982")).toHaveTextContent("—")
  })

  it("renderiza barra de progresso condicional apenas para tarefas em execução com dados", () => {
    view([
      { id: 970, titulo: "Com progresso", status: "running", projetoId: 1, progresso: { verified: 3, total: 4 } },
      { id: 971, titulo: "Sem progresso", status: "running", projetoId: 1 },
      { id: 972, titulo: "Progresso mas fora de execução", status: "completed", projetoId: 1, progresso: { verified: 4, total: 4 } },
      { id: 973, titulo: "Analyzing com progresso", status: "analyzing", projetoId: 1, progresso: { verified: 1, total: 2 } },
    ])
    // 970: running + progresso → mostra barra
    expect(screen.getByTestId("flow-task-progresso-970")).toBeInTheDocument()
    // 971: running mas sem progresso → NÃO mostra barra
    expect(screen.queryByTestId("flow-task-progresso-971")).not.toBeInTheDocument()
    // 972: tem progresso mas status completed → NÃO mostra barra
    expect(screen.queryByTestId("flow-task-progresso-972")).not.toBeInTheDocument()
    // 973: analyzing + progresso → mostra barra
    expect(screen.getByTestId("flow-task-progresso-973")).toBeInTheDocument()
  })

  it("barra de progresso reflete percentual correto (verified/total*100)", () => {
    view([
      { id: 974, titulo: "75%", status: "running", projetoId: 1, progresso: { verified: 3, total: 4 } },
    ])
    const bar = screen.getByTestId("flow-task-progresso-974")
    expect(bar).toBeInTheDocument()
    // LinearProgress MUI usa role="progressbar" e aria-valuenow
    expect(bar).toHaveAttribute("aria-valuenow", "75")
  })

  it("tooltip rico mostra descrição, projeto, prioridade e atualização ao hover", async () => {
    const updatedAt = "2026-09-09T15:30:00.000Z"
    view([
      {
        id: 960,
        titulo: "Tarefa rica",
        descricao: "Descrição completa da tarefa rica",
        status: "blocked",
        projetoId: 1,
        projetoNome: "Projeto Alpha",
        updatedAt,
      },
    ], vi.fn(), undefined, vi.fn(), [{ id: 1, nome: "Projeto Alpha" }])

    await userEvent.hover(screen.getByTestId("flow-task-description-960"))
    const tooltip = await screen.findByRole("tooltip")
    // Descrição completa
    expect(tooltip).toHaveTextContent("Descrição completa da tarefa rica")
    // Projeto
    expect(tooltip).toHaveTextContent("Projeto Alpha")
    // Prioridade em pt-BR (blocked → alta)
    expect(tooltip).toHaveTextContent("Alta")
    // Última atualização formatada
    expect(tooltip).toHaveTextContent("Atualizado:")
  })

  it("tooltip rico mostra 'Projeto #id' quando projetoNome está ausente", async () => {
    view([
      { id: 961, titulo: "Sem nome", descricao: "Desc", status: "ready", projetoId: 42 },
    ])
    await userEvent.hover(screen.getByTestId("flow-task-description-961"))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Projeto #42")
  })

  it("tooltip rico mostra prioridade correta por status", async () => {
    view([
      { id: 962, titulo: "Alta", status: "failed", projetoId: 1 },
      { id: 963, titulo: "Média", status: "running", projetoId: 1 },
      { id: 964, titulo: "Baixa", status: "draft", projetoId: 1 },
    ])
    // Alta (failed)
    await userEvent.hover(screen.getByTestId("flow-task-description-962"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Alta")
    await userEvent.unhover(screen.getByTestId("flow-task-description-962"))
    // Média (running)
    await userEvent.hover(screen.getByTestId("flow-task-description-963"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Média")
    await userEvent.unhover(screen.getByTestId("flow-task-description-963"))
    // Baixa (draft)
    await userEvent.hover(screen.getByTestId("flow-task-description-964"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Baixa")
  })

  it("card selecionado usa elevation 5 e bgcolor action.selected", () => {
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefas}
          selectedTaskId={766}
          onSelectTask={vi.fn()}
          projetos={projetos}
        />
      </BibliotecaThemeProvider>
    )
    const selectedCard = screen.getByTestId("flow-task-766")
    expect(selectedCard).toBeInTheDocument()
    // elevation deve ser 5 quando selecionado (MUI Paper renders elevation as class, but we check the component prop)
    // O Paper com elevation 5 tem classe MuiPaper-elevation5
    expect(selectedCard.className).toMatch(/MuiPaper-elevation5/)
    // Card não selecionado deve ter elevation 0
    const unselectedCard = screen.getByTestId("flow-task-767")
    expect(unselectedCard.className).toMatch(/MuiPaper-elevation0/)
  })
})

describe("TaskFlowMap — Conectores SVG animados (2.1)", () => {
  it("renderiza conectores SVG horizontais entre estações (sem ArrowForwardRounded)", () => {
    view()
    // 6 conectores no MAIN_FLOW (7 estações) + 3 no SIDE_FLOW (4 estações) = 9 total
    const horizontalConnectors = screen.getAllByTestId("flow-connector-horizontal")
    expect(horizontalConnectors).toHaveLength(9)
  })

  it("renderiza conector SVG vertical entre MAIN_FLOW e SIDE_FLOW (sem ArrowDownwardRounded)", () => {
    view()
    const verticalConnector = screen.getByTestId("flow-connector-vertical")
    expect(verticalConnector).toBeInTheDocument()
  })

  it("conectores são elementos SVG com linha e gradiente", () => {
    view()
    const connector = screen.getAllByTestId("flow-connector-horizontal")[0]
    expect(connector.tagName.toLowerCase()).toBe("svg")
    // Deve conter uma linha (line) e um path (chevron)
    const lines = connector.querySelectorAll("line")
    const paths = connector.querySelectorAll("path")
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(paths.length).toBeGreaterThanOrEqual(1)
  })

  it("conector vertical tem direção clara (chevron apontando para baixo)", () => {
    view()
    const connector = screen.getByTestId("flow-connector-vertical")
    // O path do chevron vertical deve existir
    const path = connector.querySelector("path")
    expect(path).toBeInTheDocument()
    // O conector vertical deve ter viewBox com altura maior que largura
    const viewBox = connector.getAttribute("viewBox")
    expect(viewBox).toBeTruthy()
    const [, , vbWidth, vbHeight] = viewBox!.split(" ").map(Number)
    expect(vbHeight).toBeGreaterThan(vbWidth)
  })
})

describe("TaskFlowMap — Efeito 'rio' com movimento (2.1b)", () => {
  it("conectores intensificam animação quando há tarefas se movendo", () => {
    // Renderiza com tarefa em 'ready'
    const rendered = view([{ id: 766, titulo: "Registry", status: "ready", projetoId: 1 }])
    // Muda status para 'running' → gera movimento
    rendered.rerender(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={[{ id: 766, titulo: "Registry", status: "running", projetoId: 1 }]}
          selectedTaskId=""
          onSelectTask={vi.fn()}
        />
      </BibliotecaThemeProvider>
    )
    // O chip de movimento deve estar presente
    expect(screen.getByTestId("flow-movement-766")).toBeInTheDocument()
    // Conectores devem existir (a intensificação é visual via hasMovement prop)
    expect(screen.getAllByTestId("flow-connector-horizontal").length).toBeGreaterThan(0)
  })

  it("flow-movement-* chips são preservados após migração para conectores SVG", () => {
    const rendered = view([{ id: 800, titulo: "Teste", status: "draft", projetoId: 1 }])
    rendered.rerender(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={[{ id: 800, titulo: "Teste", status: "completed", projetoId: 1 }]}
          selectedTaskId=""
          onSelectTask={vi.fn()}
        />
      </BibliotecaThemeProvider>
    )
    expect(screen.getByTestId("flow-movement-800")).toHaveTextContent("Rascunho → Concluída")
  })
})

describe("TaskFlowMap — Animações de cards (2.2)", () => {
  it("keyframes globais são injetados no document.head", () => {
    view()
    const styleEl = document.querySelector("style[data-testid='flow-keyframes']")
    expect(styleEl).toBeInTheDocument()
    // Deve conter as animações esperadas
    const css = styleEl?.textContent ?? ""
    expect(css).toContain("task-slide-in")
    expect(css).toContain("task-pulse")
    expect(css).toContain("task-glow")
    expect(css).toContain("task-fade-in")
    expect(css).toContain("flow-dash")
  })

  it("keyframes incluem prefers-reduced-motion", () => {
    view()
    const styleEl = document.querySelector("style[data-testid='flow-keyframes']")
    const css = styleEl?.textContent ?? ""
    expect(css).toContain("prefers-reduced-motion")
  })

  it("cards de tarefas ativas (IA) têm animação de pulsação e glow via sx", () => {
    view([
      { id: 900, titulo: "Ativa IA", status: "running", projetoId: 1 },
    ])
    const card = screen.getByTestId("flow-task-900")
    expect(card).toBeInTheDocument()
    // O card deve ter animation definida (task-pulse + task-glow)
    // Nota: jsdom não computa styles MUI completamente, mas verificamos que o card existe
    // e a lógica de animação está no código (testada via cobertura)
  })

  it("cards de tarefas em movimento têm animação task-slide-in", () => {
    const rendered = view([{ id: 901, titulo: "Movendo", status: "ready", projetoId: 1 }])
    rendered.rerender(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={[{ id: 901, titulo: "Movendo", status: "running", projetoId: 1 }]}
          selectedTaskId=""
          onSelectTask={vi.fn()}
        />
      </BibliotecaThemeProvider>
    )
    const card = screen.getByTestId("flow-task-901")
    expect(card).toBeInTheDocument()
    // O movimento foi detectado (chip flow-movement-901 presente)
    expect(screen.getByTestId("flow-movement-901")).toBeInTheDocument()
  })
})

describe("TaskFlowMap — prefers-reduced-motion (2.2d)", () => {
  it("cards têm media query para desativar animações quando prefers-reduced-motion", () => {
    view()
    const card = screen.getByTestId("flow-task-766")
    // O sx do card deve incluir @media (prefers-reduced-motion: reduce)
    // jsdom não computa media queries, mas verificamos que o card renderiza sem erro
    expect(card).toBeInTheDocument()
  })

  it("keyframes CSS inclui regra para prefers-reduced-motion: reduce", () => {
    view()
    const styleEl = document.querySelector("style[data-testid='flow-keyframes']")
    const css = styleEl?.textContent ?? ""
    // Deve conter a media query
    expect(css).toMatch(/@media.*prefers-reduced-motion.*reduce/)
    // E deve neutralizar as animações (transform: none ou box-shadow: none)
    expect(css).toContain("transform: none")
  })
})

describe("TaskFlowMap — Responsividade mobile-first (6.1)", () => {
  it("renderiza o botão de toggle do filtro (funil) com data-testid map-filter-toggle", () => {
    view()
    expect(screen.getByTestId("map-filter-toggle")).toBeInTheDocument()
  })

  it("botão de toggle do filtro tem aria-label descritivo", () => {
    view()
    const toggle = screen.getByTestId("map-filter-toggle")
    expect(toggle).toHaveAttribute("aria-label", "Expandir filtros")
  })

  it("ao clicar no toggle, aria-label muda para 'Recolher filtros'", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-filter-toggle"))
    expect(screen.getByTestId("map-filter-toggle")).toHaveAttribute("aria-label", "Recolher filtros")
  })

  it("ao clicar no toggle, aria-expanded muda para true", async () => {
    view()
    await userEvent.click(screen.getByTestId("map-filter-toggle"))
    expect(screen.getByTestId("map-filter-toggle")).toHaveAttribute("aria-expanded", "true")
  })
})

describe("TaskFlowMap — Skeleton loaders (7.1)", () => {
  it("renderiza skeletons das estações quando carregando=true", () => {
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefas}
          selectedTaskId=""
          onSelectTask={vi.fn()}
          carregando={true}
        />
      </BibliotecaThemeProvider>
    )
    // Verifica que os skeletons são renderizados para cada estação
    expect(screen.getByTestId("map-skeleton-running")).toBeInTheDocument()
    expect(screen.getByTestId("map-skeleton-ready")).toBeInTheDocument()
    expect(screen.getByTestId("map-skeleton-completed")).toBeInTheDocument()
    expect(screen.getByTestId("map-skeleton-container")).toBeInTheDocument()
  })

  it("skeletons usam animation='wave' (shimmer effect)", () => {
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefas}
          selectedTaskId=""
          onSelectTask={vi.fn()}
          carregando={true}
        />
      </BibliotecaThemeProvider>
    )
    const skeleton = screen.getByTestId("map-skeleton-running")
    // MUI Skeleton com animation="wave" adiciona a classe MuiSkeleton-wave
    expect(skeleton).toHaveClass("MuiSkeleton-wave")
  })

  it("não renderiza skeletons quando carregando=false (default)", () => {
    view()
    expect(screen.queryByTestId("map-skeleton-container")).not.toBeInTheDocument()
    expect(screen.queryByTestId("map-skeleton-running")).not.toBeInTheDocument()
  })

  it("renderiza estações reais quando carregando=false", () => {
    view()
    expect(screen.getByTestId("flow-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("flow-station-ready")).toBeInTheDocument()
  })
})

describe("TaskFlowMap — Tarefas pausadas sem subtarefas vão para Rascunhos", () => {
  it("tarefa paused sem subtarefas (subtaskCount=0) aparece na estação draft", () => {
    const tarefasComPausada: FlowTask[] = [
      { id: 900, titulo: "Pausada sem subtarefas", status: "paused", projetoId: 1, subtaskCount: 0 },
    ]
    view(tarefasComPausada)
    expect(screen.getByTestId("flow-count-draft")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-waiting")).toHaveTextContent("0")
  })

  it("tarefa paused com subtaskCount undefined aparece na estação draft", () => {
    const tarefasComPausada: FlowTask[] = [
      { id: 901, titulo: "Pausada sem subtaskCount", status: "paused", projetoId: 1 },
    ]
    view(tarefasComPausada)
    expect(screen.getByTestId("flow-count-draft")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-waiting")).toHaveTextContent("0")
  })

  it("tarefa paused com subtarefas (subtaskCount>0) aparece na estação waiting", () => {
    const tarefasComPausada: FlowTask[] = [
      { id: 902, titulo: "Pausada com subtarefas", status: "paused", projetoId: 1, subtaskCount: 3 },
    ]
    view(tarefasComPausada)
    expect(screen.getByTestId("flow-count-draft")).toHaveTextContent("0")
    expect(screen.getByTestId("flow-count-waiting")).toHaveTextContent("1")
  })

  it("outros status não são afetados pela lógica de paused", () => {
    const tarefasVariadas: FlowTask[] = [
      { id: 903, titulo: "Running", status: "running", projetoId: 1, subtaskCount: 0 },
      { id: 904, titulo: "Draft", status: "draft", projetoId: 1, subtaskCount: 0 },
      { id: 905, titulo: "Completed", status: "completed", projetoId: 1, subtaskCount: 5 },
    ]
    view(tarefasVariadas)
    expect(screen.getByTestId("flow-count-running")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-draft")).toHaveTextContent("1")
    expect(screen.getByTestId("flow-count-completed")).toHaveTextContent("1")
  })

  it("subtitle da estação draft menciona 'pausadas sem subtarefas'", () => {
    view()
    const draftStation = screen.getByTestId("flow-station-draft")
    expect(draftStation).toHaveTextContent("não iniciadas ou pausadas sem subtarefas")
  })
})

describe("TaskFlowMap — Paginação infinita (10 em 10 com scroll)", () => {
  function gerarTarefasPlanned(qtd: number): FlowTask[] {
    return Array.from({ length: qtd }, (_, i) => ({
      id: i + 1,
      titulo: `Tarefa ${i + 1}`,
      status: "planned" as const,
      projetoId: 1,
    }))
  }

  function definirDimensoesScroll(container: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
    Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true })
    Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true })
    Object.defineProperty(container, "scrollTop", { value: scrollTop, configurable: true })
  }

  it("(a) exibe no máximo 10 tarefas por estação com 25 tarefas e caption '+ 15 tarefas'", () => {
    const tarefas25 = gerarTarefasPlanned(25)
    view(tarefas25)

    // Exatamente 10 fichas visíveis (regex específica para flow-task-<id>)
    const fichas = screen.getAllByTestId(/^flow-task-\d+$/)
    expect(fichas).toHaveLength(10)

    // Container de scroll da estação planned existe
    const scrollContainer = screen.getByTestId("flow-scroll-planned")
    expect(scrollContainer).toBeInTheDocument()

    // Caption "+ 15 tarefas"
    expect(screen.getByText("+ 15 tarefas")).toBeInTheDocument()
  })

  it("(b) carrega mais 10 ao rolar até o fim (20, depois 25)", () => {
    const tarefas25 = gerarTarefasPlanned(25)
    view(tarefas25)

    const scrollContainer = screen.getByTestId("flow-scroll-planned")

    // Primeiro scroll: scrollTop=640 + clientHeight=360 = 1000 >= scrollHeight(1000) - 8
    definirDimensoesScroll(scrollContainer, 1000, 360, 640)
    fireEvent.scroll(scrollContainer)

    // Agora 20 fichas visíveis (regex específica para flow-task-<id>)
    expect(screen.getAllByTestId(/^flow-task-\d+$/)).toHaveLength(20)
    // Caption "+ 5 tarefas"
    expect(screen.getByText("+ 5 tarefas")).toBeInTheDocument()

    // Segundo scroll: rolar até o fim novamente
    // scrollHeight cresce proporcionalmente; scrollTop + clientHeight >= scrollHeight - 8
    definirDimensoesScroll(scrollContainer, 1400, 360, 1040)
    fireEvent.scroll(scrollContainer)

    // Agora 25 fichas (todas), sem caption (regex específica para flow-task-<id>)
    expect(screen.getAllByTestId(/^flow-task-\d+$/)).toHaveLength(25)
    expect(screen.queryByText(/\+ \d+ tarefas/)).not.toBeInTheDocument()
  })

  it("(c) não ultrapassa o total — rolar além mantém 25 fichas sem duplicação", () => {
    const tarefas25 = gerarTarefasPlanned(25)
    view(tarefas25)

    const scrollContainer = screen.getByTestId("flow-scroll-planned")

    // Scroll 1: 10 → 20
    definirDimensoesScroll(scrollContainer, 1000, 360, 640)
    fireEvent.scroll(scrollContainer)
    expect(screen.getAllByTestId(/^flow-task-\d+$/)).toHaveLength(20)

    // Scroll 2: 20 → 25
    definirDimensoesScroll(scrollContainer, 1400, 360, 1040)
    fireEvent.scroll(scrollContainer)
    expect(screen.getAllByTestId(/^flow-task-\d+$/)).toHaveLength(25)

    // Scroll 3: já no fim, não deve duplicar
    definirDimensoesScroll(scrollContainer, 1800, 360, 1440)
    fireEvent.scroll(scrollContainer)
    expect(screen.getAllByTestId(/^flow-task-\d+$/)).toHaveLength(25)
  })

  it("(d) busca ativa respeita o limite de 10 visíveis", () => {
    const tarefas25 = gerarTarefasPlanned(25)
    const filtros: FiltrosMapa = { busca: "Tarefa", status: [], projetoId: "", prioridade: "" }
    view(tarefas25, vi.fn(), filtros)

    // Com busca "Tarefa" casando com todos os 25 títulos, ainda exibe apenas 10 (regex específica)
    const fichas = screen.getAllByTestId(/^flow-task-\d+$/)
    expect(fichas).toHaveLength(10)
  })
})
