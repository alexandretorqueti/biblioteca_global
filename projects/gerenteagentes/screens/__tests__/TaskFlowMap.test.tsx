// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import TaskFlowMap, { type FlowTask } from "../TaskFlowMap"

const tarefas: FlowTask[] = [
  { id: 766, titulo: "Registry de telas", status: "running", projetoId: 1 },
  { id: 767, titulo: "Documentar API", status: "ready", projetoId: 1 },
  { id: 768, titulo: "Corrigir testes", status: "motor_fix", projetoId: 1 },
  { id: 769, titulo: "Publicar versão", status: "completed", projetoId: 1 },
]

function view(items = tarefas, onSelectTask = vi.fn()) {
  return render(<BibliotecaThemeProvider><TaskFlowMap tarefas={items} selectedTaskId="" onSelectTask={onSelectTask} /></BibliotecaThemeProvider>)
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

  it("destaca uma transição quando o status muda", () => {
    const rendered = view([{ id: 766, titulo: "Registry", status: "ready", projetoId: 1 }])
    rendered.rerender(<BibliotecaThemeProvider><TaskFlowMap tarefas={[{ id: 766, titulo: "Registry", status: "running", projetoId: 1 }]} selectedTaskId="" onSelectTask={vi.fn()} /></BibliotecaThemeProvider>)
    expect(screen.getByTestId("flow-movement-766")).toHaveTextContent("Pronta → Em execução")
  })
})
