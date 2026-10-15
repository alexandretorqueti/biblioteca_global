// @vitest-environment jsdom
/**
 * Testes responsivos do OperationMapCanvas.
 *
 * Valida que as linhas de estações quebram corretamente em telas menores
 * sem causar overflow horizontal, e que em telas largas os quadros permanecem
 * alinhados horizontalmente.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
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

function renderCanvas(tarefas: FlowTask[] = [], viewportWidth: number = 1024, selectedTaskId: number | "" = "") {
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
        selectedTaskId={selectedTaskId}
        projetos={[{ id: 1, nome: "Projeto X" }]}
        motorActivities={[]}
        onSelectTask={() => {}}
      />
    </BibliotecaThemeProvider>,
  )
}

describe("OperationMapCanvas — responsividade", () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
    expect(screen.getByTestId("operation-station-cancelled")).toBeInTheDocument()
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

  it("exibe os marcadores do quadro em ordem numérica decrescente", () => {
    renderCanvas([
      tarefaFactory(2, "Tarefa 2", "draft"),
      tarefaFactory(100, "Tarefa 100", "draft"),
      tarefaFactory(10, "Tarefa 10", "draft"),
      tarefaFactory(1, "Tarefa 1", "draft"),
      tarefaFactory(20, "Tarefa 20", "draft"),
      tarefaFactory(3, "Tarefa 3", "draft"),
    ] as FlowTask[])

    const markers = within(screen.getByTestId("operation-station-draft")).getAllByTestId(/operation-map-task-/)
    expect(markers.map(marker => marker.getAttribute("data-testid"))).toEqual([
      "operation-map-task-100",
      "operation-map-task-20",
      "operation-map-task-10",
      "operation-map-task-3",
      "operation-map-task-2",
    ])
    expect(screen.queryByTestId("operation-map-task-1")).not.toBeInTheDocument()
  })

  it("separa tarefas encerradas sem deploy das canceladas", () => {
    renderCanvas([
      tarefaFactory(1, "Verificação", "closed"),
      tarefaFactory(2, "Cancelada", "cancelled"),
      tarefaFactory(3, "Abortada", "aborted"),
    ] as FlowTask[], 1280)
    expect(screen.getByTestId("operation-station-closed")).toHaveTextContent("Encerradas")
    expect(screen.getByTestId("operation-count-closed")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-station-cancelled")).toHaveTextContent("Canceladas")
    expect(screen.getByTestId("operation-count-cancelled")).toHaveTextContent("2")
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

  it("destaca a borda do marcador da tarefa selecionada", () => {
    const tarefas = [
      tarefaFactory(1, "Tarefa selecionada", "draft"),
      tarefaFactory(2, "Tarefa não selecionada", "draft"),
    ]
    renderCanvas(tarefas as FlowTask[], 1024, 1)

    const selectedMarker = screen.getByTestId("operation-map-task-1")
    const unselectedMarker = screen.getByTestId("operation-map-task-2")

    expect(selectedMarker).toHaveAttribute("data-selection-border-width", "4")
    expect(selectedMarker).toHaveAttribute("data-selection-border-color", "secondary.main")
    expect(unselectedMarker).toHaveAttribute("data-selection-border-width", "0")
    expect(unselectedMarker).not.toHaveAttribute("data-selection-border-color")
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

  it("anima o marcador quando a tarefa muda de estação", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const station = this.closest("[data-testid^='operation-station-']")?.getAttribute("data-testid")
      const left = station === "operation-station-running" ? 100 : station === "operation-station-completed" ? 300 : 0
      return { left, top: 0, right: left + 30, bottom: 30, width: 30, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect
    })

    const initialTask = tarefaFactory(1, "Tarefa em movimento", "running")
    const view = renderCanvas([initialTask as FlowTask])
    expect(animate).not.toHaveBeenCalled()

    view.rerender(<BibliotecaThemeProvider><OperationMapCanvas
      tarefas={[{ ...initialTask, status: "completed" } as FlowTask]}
      selectedTaskId=""
      projetos={[{ id: 1, nome: "Projeto X" }]}
      motorActivities={[]}
      onSelectTask={() => {}}
    /></BibliotecaThemeProvider>)

    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translate(-200px, 0px)" }, { transform: "translate(0px, 0px)" }],
      { duration: 3000, easing: "ease-out", fill: "both" },
    )
  })

  it("anima transições entre quadros principal e de exceção", () => {
    const firstCancel = vi.fn()
    const secondCancel = vi.fn()
    const animate = vi.fn()
      .mockImplementationOnce(() => ({ cancel: firstCancel }) as unknown as Animation)
      .mockImplementationOnce(() => ({ cancel: secondCancel }) as unknown as Animation)
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const station = this.closest("[data-testid^='operation-station-']")?.getAttribute("data-testid")
      const left = station === "operation-station-running" ? 100 : station === "operation-station-waiting" ? 500 : 0
      return { left, top: 0, right: left + 30, bottom: 30, width: 30, height: 30, x: left, y: 0, toJSON: () => ({}) } as DOMRect
    })

    const initialTask = tarefaFactory(1, "Tarefa em movimento", "running")
    const view = renderCanvas([initialTask as FlowTask])

    view.rerender(<BibliotecaThemeProvider><OperationMapCanvas
      tarefas={[{ ...initialTask, status: "awaiting_clarification" } as FlowTask]}
      selectedTaskId=""
      projetos={[{ id: 1, nome: "Projeto X" }]}
      motorActivities={[]}
      onSelectTask={() => {}}
    /></BibliotecaThemeProvider>)

    view.rerender(<BibliotecaThemeProvider><OperationMapCanvas
      tarefas={[{ ...initialTask, status: "completed" } as FlowTask]}
      selectedTaskId=""
      projetos={[{ id: 1, nome: "Projeto X" }]}
      motorActivities={[]}
      onSelectTask={() => {}}
    /></BibliotecaThemeProvider>)

    expect(animate).toHaveBeenCalledTimes(2)
    expect(firstCancel).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenNthCalledWith(
      1,
      [{ transform: "translate(-400px, 0px)" }, { transform: "translate(0px, 0px)" }],
      { duration: 3000, easing: "ease-out", fill: "both" },
    )
    expect(animate).toHaveBeenNthCalledWith(
      2,
      [{ transform: "translate(500px, 0px)" }, { transform: "translate(0px, 0px)" }],
      { duration: 3000, easing: "ease-out", fill: "both" },
    )
  })

  it("mantém o mapa funcional quando Web Animations API não está disponível", () => {
    const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate")
    Reflect.deleteProperty(HTMLElement.prototype, "animate")

    try {
      const initialTask = tarefaFactory(1, "Tarefa sem animação", "running")
      const view = renderCanvas([initialTask as FlowTask])

      expect(() => view.rerender(<BibliotecaThemeProvider><OperationMapCanvas
        tarefas={[{ ...initialTask, status: "completed" } as FlowTask]}
        selectedTaskId=""
        projetos={[{ id: 1, nome: "Projeto X" }]}
        motorActivities={[]}
        onSelectTask={() => {}}
      /></BibliotecaThemeProvider>)).not.toThrow()
      expect(screen.getByTestId("operation-map-task-1")).toBeInTheDocument()
    } finally {
      if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor)
    }
  })

  it("não anima na montagem inicial nem com reduced-motion", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate })
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, media: "(prefers-reduced-motion: reduce)" })),
    })

    const initialTask = tarefaFactory(1, "Tarefa", "running")
    const view = renderCanvas([initialTask as FlowTask])
    expect(animate).not.toHaveBeenCalled()
    view.rerender(<BibliotecaThemeProvider><OperationMapCanvas
      tarefas={[{ ...initialTask, status: "completed" } as FlowTask]}
      selectedTaskId=""
      projetos={[{ id: 1, nome: "Projeto X" }]}
      motorActivities={[]}
      onSelectTask={() => {}}
    /></BibliotecaThemeProvider>)
    expect(animate).not.toHaveBeenCalled()
  })
})
