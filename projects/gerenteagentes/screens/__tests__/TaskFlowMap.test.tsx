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
    view([{ id: 772, titulo: "Sem descrição", descricao: null, status: "ready", projetoId: 1 }])

    await userEvent.hover(screen.getByTestId("flow-task-description-772"))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Tarefa sem descrição")
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
