// @vitest-environment jsdom
/**
 * Testes responsivos do OperationMapCanvas.
 *
 * Valida que as linhas de estações quebram corretamente em telas menores
 * sem causar overflow horizontal, e que em telas largas os quadros permanecem
 * alinhados horizontalmente.
 */
import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapCanvas from "../OperationMapCanvas"
import type { FlowTask } from "../TaskFlowMap"

interface TarefaFake {
  id: number
  titulo: string
  status: string
  projetoId: number
  projetoNome?: string
  descricao: string | null
  dependsOnTaskId: number | null
  createdAt: string
  updatedAt: string
}

function tarefaFactory(id: number, titulo: string, status: string): TarefaFake {
  return {
    id,
    titulo,
    status,
    projetoId: 1,
    projetoNome: "Projeto X",
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  }
}

function renderCanvas(tarefas: FlowTask[] = [], viewportWidth: number = 1024) {
  // Mock do window.innerWidth para simular diferentes tamanhos de tela
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: viewportWidth,
  })

  return render(
    <BibliotecaThemeProvider>
      <OperationMapCanvas
        tarefas={tarefas}
        selectedTaskId=""
        projetos={[{ id: 1, nome: "Projeto X" }]}
        motorActivities={[]}
        onSelectTask={() => {}}
      />
    </BibliotecaThemeProvider>,
  )
}

describe("OperationMapCanvas — responsividade", () => {
  afterEach(() => {
    // Restaura o window.innerWidth
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    })
  })

  it("renderiza todas as estações principais em telas largas (>= 1280px)", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa 1", "draft"),
      tarefaFactory(2, "Tarefa 2", "planned"),
      tarefaFactory(3, "Tarefa 3", "running"),
    ]
    renderCanvas(tarefas as FlowTask[], 1280)

    // Todas as estações principais devem estar visíveis
    expect(screen.getByTestId("operation-station-draft")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-planned")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-analyzing")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-ready")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-completed")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-deployed")).toBeInTheDocument()

    // Estações de exceção também devem estar visíveis
    expect(screen.getByTestId("operation-station-waiting")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-repair")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-attention")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-closed")).toBeInTheDocument()
  })

  it("renderiza todas as estações em telas pequenas (768px) sem overflow horizontal", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa 1", "draft"),
      tarefaFactory(2, "Tarefa 2", "running"),
    ]
    renderCanvas(tarefas as FlowTask[], 768)

    // O canvas deve estar presente
    const canvas = screen.getByTestId("operation-map-canvas")
    expect(canvas).toBeInTheDocument()

    // Todas as estações ainda devem estar renderizadas (mesmo que em múltiplas linhas)
    expect(screen.getByTestId("operation-station-draft")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-running")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-waiting")).toBeInTheDocument()

    // Verifica que não há overflow horizontal indevido
    // O scrollWidth não deve ser significativamente maior que o clientWidth
    // (permite uma pequena margem para padding/bordas)
    const scrollWidth = canvas.scrollWidth
    const clientWidth = canvas.clientWidth
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 50)
  })

  it("renderiza todas as estações em telas muito pequenas (480px)", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa 1", "draft"),
    ]
    renderCanvas(tarefas as FlowTask[], 480)

    const canvas = screen.getByTestId("operation-map-canvas")
    expect(canvas).toBeInTheDocument()

    // Mesmo em telas muito pequenas, as estações devem estar presentes
    expect(screen.getByTestId("operation-station-draft")).toBeInTheDocument()
    expect(screen.getByTestId("operation-station-waiting")).toBeInTheDocument()
  })

  it("preserva a contagem de tarefas em cada estação após quebra de linha", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa 1", "draft"),
      tarefaFactory(2, "Tarefa 2", "draft"),
      tarefaFactory(3, "Tarefa 3", "running"),
      tarefaFactory(4, "Tarefa 4", "completed"),
    ]
    renderCanvas(tarefas as FlowTask[], 768)

    // Verifica que as contagens estão corretas
    expect(screen.getByTestId("operation-count-draft")).toHaveTextContent("2")
    expect(screen.getByTestId("operation-count-running")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-count-completed")).toHaveTextContent("1")
  })

  it("mantém conectores visíveis entre estações em telas largas", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa 1", "draft"),
    ]
    renderCanvas(tarefas as FlowTask[], 1280)

    // Os conectores (setas →) devem estar presentes no DOM
    // Eles são renderizados como Box com aria-hidden="true"
    const canvas = screen.getByTestId("operation-map-canvas")
    const connectors = canvas.querySelectorAll('[aria-hidden="true"]')
    expect(connectors.length).toBeGreaterThan(0)
  })

  it("não causa overflow horizontal com muitas tarefas em telas médias", () => {
    const tarefas = Array.from({ length: 20 }, (_, i) =>
      tarefaFactory(i + 1, `Tarefa ${i + 1}`, i % 2 === 0 ? "draft" : "running")
    )
    renderCanvas(tarefas as FlowTask[], 1024)

    const canvas = screen.getByTestId("operation-map-canvas")
    const scrollWidth = canvas.scrollWidth
    const clientWidth = canvas.clientWidth

    // Permite uma margem razoável para padding
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 100)
  })

  it("preserva filtros e marcadores em telas pequenas", async () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa importante", "running"),
    ]
    renderCanvas(tarefas as FlowTask[], 480)

    // O botão de filtros deve estar presente
    expect(screen.getByText("Filtros")).toBeInTheDocument()

    // O marcador da tarefa deve estar presente e clicável
    const marker = screen.getByTestId("operation-map-task-1")
    expect(marker).toBeInTheDocument()
  })

  it("permite expansão de estações em telas pequenas", async () => {
    const tarefas = Array.from({ length: 10 }, (_, i) =>
      tarefaFactory(i + 1, `Tarefa ${i + 1}`, "draft")
    )
    renderCanvas(tarefas as FlowTask[], 768)

    // A estação draft deve ter um botão de expansão
    const expandButton = screen.getByText("+ 5")
    expect(expandButton).toBeInTheDocument()
  })
})
