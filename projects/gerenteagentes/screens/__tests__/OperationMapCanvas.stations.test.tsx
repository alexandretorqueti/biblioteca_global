// @vitest-environment jsdom
/**
 * Regressão do quadro — task-p2-1047, subtarefa 4 (caso real task-p6-1029):
 * tarefa com status derivado `closed` (encerrada por veredito, sem deploy)
 * deve cair na estação "Encerradas" e NUNCA em "Canceladas"; a estação
 * "Canceladas" continua restrita a `cancelled`/`aborted`.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapCanvas from "../OperationMapCanvas"
import type { FlowTask } from "../TaskFlowMap"

function tarefa(id: number, titulo: string, status: string): FlowTask {
  return { id, titulo, status, projetoId: 1 }
}

function renderCanvas(tarefas: FlowTask[]) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 })
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

describe("OperationMapCanvas — closed ≠ cancelada (caso 1029)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 })
  })

  it("tarefa closed cai na estação Encerradas e nunca em Canceladas", () => {
    renderCanvas([
      tarefa(1029, "Veredito cross-project", "closed"),
      tarefa(1030, "Cancelada pelo usuário", "cancelled"),
      tarefa(1031, "Abortada", "aborted"),
    ])

    const encerradas = screen.getByTestId("operation-station-closed")
    const canceladas = screen.getByTestId("operation-station-cancelled")

    expect(encerradas).toHaveTextContent("Encerradas")
    expect(canceladas).toHaveTextContent("Canceladas")

    // A tarefa closed pertence à estação Encerradas...
    expect(within(encerradas).getByTestId("operation-map-task-1029")).toBeInTheDocument()
    // ...e jamais aparece entre as Canceladas (regressão do caso 1029).
    expect(within(canceladas).queryByTestId("operation-map-task-1029")).not.toBeInTheDocument()

    // Contadores coerentes: 1 encerrada, 2 canceladas (cancelled + aborted).
    expect(screen.getByTestId("operation-count-closed")).toHaveTextContent("1")
    expect(screen.getByTestId("operation-count-cancelled")).toHaveTextContent("2")
  })

  it("estação Canceladas continua restrita a cancelled/aborted", () => {
    renderCanvas([
      tarefa(2001, "Encerrada por veredito", "closed"),
      tarefa(2002, "Cancelada", "cancelled"),
      tarefa(2003, "Abortada", "aborted"),
    ])

    const canceladas = screen.getByTestId("operation-station-cancelled")
    expect(within(canceladas).getByTestId("operation-map-task-2002")).toBeInTheDocument()
    expect(within(canceladas).getByTestId("operation-map-task-2003")).toBeInTheDocument()
    expect(within(canceladas).queryByTestId("operation-map-task-2001")).not.toBeInTheDocument()

    const encerradas = screen.getByTestId("operation-station-closed")
    expect(within(encerradas).getByTestId("operation-map-task-2001")).toBeInTheDocument()
    expect(within(encerradas).queryByTestId("operation-map-task-2002")).not.toBeInTheDocument()
    expect(within(encerradas).queryByTestId("operation-map-task-2003")).not.toBeInTheDocument()
  })
})
