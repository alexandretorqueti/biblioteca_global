// @vitest-environment jsdom
/**
 * Testes do AgentStatusStrip — exibição de códigos de tarefa/subtarefa por agente
 * e códigos da leva de deploy no Motor.
 *
 * Valida:
 * - Ícone ativo exibe o código da tarefa (#taskId) e subtarefa (·SsubtaskId)
 * - Ícone inativo não exibe código
 * - Motor em deploy exibe múltiplos taskIds como chips
 * - Motor ocioso não exibe códigos de tarefa
 */
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import AgentStatusStrip from "../AgentStatusStrip"

function renderStrip(props: Partial<React.ComponentProps<typeof AgentStatusStrip>> = {}) {
  return render(
    <BibliotecaThemeProvider>
      <AgentStatusStrip
        motorActive
        motorIsRunning={false}
        motorActivity={null}
        workers={[]}
        {...props}
      />
    </BibliotecaThemeProvider>,
  )
}

describe("AgentStatusStrip — códigos de tarefa/subtarefa por agente", () => {
  it("exibe o código da tarefa quando o Analista está ativo", () => {
    renderStrip({
      workers: [
        { role: "analyst", active: true, model: "gpt-5.6-luna", taskId: "886", subtaskId: 905, phase: "executing" },
        { role: "developer", active: false, model: null, taskId: null, subtaskId: null, phase: null },
        { role: "manager", active: false, model: null, taskId: null, subtaskId: null, phase: null },
      ],
    })

    const code = screen.getByTestId("agent-task-code-analyst")
    expect(code).toBeInTheDocument()
    expect(code).toHaveTextContent("#886")
    expect(code).toHaveTextContent("· S905")
  })

  it("exibe apenas o taskId quando não há subtaskId", () => {
    renderStrip({
      workers: [
        { role: "analyst", active: false, model: null, taskId: null, subtaskId: null, phase: null },
        { role: "developer", active: true, model: "qwen3.7-max", taskId: "912", subtaskId: null, phase: "worktree" },
        { role: "manager", active: false, model: null, taskId: null, subtaskId: null, phase: null },
      ],
    })

    const code = screen.getByTestId("agent-task-code-developer")
    expect(code).toBeInTheDocument()
    expect(code).toHaveTextContent("#912")
    expect(code).not.toHaveTextContent("· S")
  })

  it("não exibe código quando o agente está inativo", () => {
    renderStrip({
      workers: [
        { role: "analyst", active: false, model: "gpt-5.6-luna", taskId: "886", subtaskId: null, phase: null },
        { role: "developer", active: false, model: null, taskId: null, subtaskId: null, phase: null },
        { role: "manager", active: false, model: null, taskId: null, subtaskId: null, phase: null },
      ],
    })

    expect(screen.queryByTestId("agent-task-code-analyst")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-task-code-developer")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-task-code-manager")).not.toBeInTheDocument()
  })

  it("Monitor (manager) exibe código da tarefa quando ativo", () => {
    renderStrip({
      workers: [
        { role: "analyst", active: false, model: null, taskId: null, subtaskId: null, phase: null },
        { role: "developer", active: false, model: null, taskId: null, subtaskId: null, phase: null },
        { role: "manager", active: true, model: "qwen3.8-max", taskId: "770", subtaskId: 1228, phase: "deploying" },
      ],
    })

    const code = screen.getByTestId("agent-task-code-manager")
    expect(code).toBeInTheDocument()
    expect(code).toHaveTextContent("#770")
    expect(code).toHaveTextContent("· S1228")
  })
})

describe("AgentStatusStrip — Motor: leva de deploy", () => {
  it("exibe múltiplos taskIds como chips quando o motor está em deploy", () => {
    renderStrip({
      motorActive: true,
      motorIsRunning: true,
      motorActivity: {
        kind: "deploying",
        message: "fazendo deploy das tarefas 886, 912",
        taskIds: ["886", "912"],
      },
      workers: [],
    })

    expect(screen.getByTestId("motor-deploy-task-886")).toBeInTheDocument()
    expect(screen.getByTestId("motor-deploy-task-886")).toHaveTextContent("#886")
    expect(screen.getByTestId("motor-deploy-task-912")).toBeInTheDocument()
    expect(screen.getByTestId("motor-deploy-task-912")).toHaveTextContent("#912")
  })

  it("não exibe chips de taskId quando o motor está ocioso", () => {
    renderStrip({
      motorActive: true,
      motorIsRunning: false,
      motorActivity: null,
      workers: [],
    })

    expect(screen.queryByTestId("motor-deploy-task-886")).not.toBeInTheDocument()
    expect(screen.queryByTestId("motor-deploy-task-912")).not.toBeInTheDocument()
  })

  it("não exibe chips de taskId quando o motor está executando (não-deploy)", () => {
    renderStrip({
      motorActive: true,
      motorIsRunning: true,
      motorActivity: {
        kind: "executing",
        message: "motor executando tarefa 886",
        taskIds: ["886"],
      },
      workers: [],
    })

    // taskIds só aparecem como chips quando kind === 'deploying'
    expect(screen.queryByTestId("motor-deploy-task-886")).not.toBeInTheDocument()
  })

  it("exibe 'Motor pausado' quando motorActive é false", () => {
    renderStrip({
      motorActive: false,
      motorIsRunning: false,
      motorActivity: null,
      workers: [],
    })

    expect(screen.getByTestId("motor-state-box")).toHaveTextContent("Motor pausado")
  })
})
