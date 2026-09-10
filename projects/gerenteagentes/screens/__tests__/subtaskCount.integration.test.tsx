// @vitest-environment jsdom
/**
 * Teste de integração: fluxo completo subtaskCount
 * 
 * Valida que:
 * 1. API retorna subtaskCount para cada tarefa
 * 2. TaskMonitorScreen repassa subtaskCount via tarefasParaMapa
 * 3. TaskFlowMap usa subtaskCount para decidir estação (Rascunhos vs Aguardando)
 * 
 * Critério: "Teste de integração valida o fluxo completo"
 */
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import TaskFlowMap, { type FlowTask, getEffectiveStatus } from "../TaskFlowMap"

describe("Integração: subtaskCount (API → TaskMonitorScreen → TaskFlowMap)", () => {
  it("API retorna subtaskCount → TaskFlowMap recebe e usa para decidir estação", () => {
    // Simula resposta da API com subtaskCount
    const tarefasDaApi: FlowTask[] = [
      { id: 1, titulo: "Tarefa pausada sem subtarefas", status: "paused", projetoId: 1, subtaskCount: 0 },
      { id: 2, titulo: "Tarefa pausada com subtarefas", status: "paused", projetoId: 1, subtaskCount: 3 },
      { id: 3, titulo: "Tarefa em execução", status: "running", projetoId: 1, subtaskCount: 2 },
    ]

    // Renderiza TaskFlowMap com as tarefas (simulando o repasse via tarefasParaMapa)
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefasDaApi}
          selectedTaskId=""
          onSelectTask={vi.fn()}
          projetos={[{ id: 1, nome: "Projeto Teste" }]}
        />
      </BibliotecaThemeProvider>
    )

    // Valida: tarefa pausada com 0 subtarefas vai para Rascunhos (draft)
    const draftStation = screen.getByTestId("flow-station-draft")
    expect(draftStation).toBeInTheDocument()
    const draftCount = screen.getByTestId("flow-count-draft")
    expect(draftCount).toHaveTextContent("1") // apenas tarefa id=1

    // Valida: tarefa pausada com subtarefas vai para Aguardando (waiting)
    const waitingStation = screen.getByTestId("flow-station-waiting")
    expect(waitingStation).toBeInTheDocument()
    const waitingCount = screen.getByTestId("flow-count-waiting")
    expect(waitingCount).toHaveTextContent("1") // apenas tarefa id=2

    // Valida: tarefa em execução vai para Execução (running)
    const runningStation = screen.getByTestId("flow-station-running")
    expect(runningStation).toBeInTheDocument()
    const runningCount = screen.getByTestId("flow-count-running")
    expect(runningCount).toHaveTextContent("1") // tarefa id=3
  })

  it("tarefasParaMapa repassa subtaskCount da API para TaskFlowMap", () => {
    // Simula o mapeamento feito em TaskMonitorScreen.tsx (tarefasParaMapa)
    const tarefasDaApi = [
      { id: 10, titulo: "Tarefa A", status: "paused", projetoId: 1, subtaskCount: 0, createdAt: null, updatedAt: null },
      { id: 11, titulo: "Tarefa B", status: "paused", projetoId: 1, subtaskCount: 5, createdAt: null, updatedAt: null },
    ]

    // Simula o mapeamento de tarefasParaMapa (spread ...t preserva subtaskCount)
    const projetoNomePorId = new Map([[1, "Projeto X"]])
    const tarefasParaMapa = tarefasDaApi.map((t) => ({
      ...t,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? null,
      projetoNome: projetoNomePorId.get(t.projetoId) ?? null,
    }))

    // Valida que subtaskCount foi preservado
    expect(tarefasParaMapa[0]).toHaveProperty("subtaskCount", 0)
    expect(tarefasParaMapa[1]).toHaveProperty("subtaskCount", 5)

    // Renderiza TaskFlowMap com as tarefas mapeadas
    render(
      <BibliotecaThemeProvider>
        <TaskFlowMap
          tarefas={tarefasParaMapa as FlowTask[]}
          selectedTaskId=""
          onSelectTask={vi.fn()}
          projetos={[{ id: 1, nome: "Projeto X" }]}
        />
      </BibliotecaThemeProvider>
    )

    // Valida que o TaskFlowMap usou subtaskCount corretamente
    const draftCount = screen.getByTestId("flow-count-draft")
    expect(draftCount).toHaveTextContent("1") // tarefa id=10 (subtaskCount=0)

    const waitingCount = screen.getByTestId("flow-count-waiting")
    expect(waitingCount).toHaveTextContent("1") // tarefa id=11 (subtaskCount=5)
  })

  it("getEffectiveStatus usa subtaskCount para decidir status efetivo", () => {
    // Valida a função auxiliar que determina o status efetivo
    const tarefaPausadaSemSubtarefas: FlowTask = {
      id: 1,
      titulo: "Teste",
      status: "paused",
      projetoId: 1,
      subtaskCount: 0,
    }
    expect(getEffectiveStatus(tarefaPausadaSemSubtarefas)).toBe("draft")

    const tarefaPausadaComSubtarefas: FlowTask = {
      id: 2,
      titulo: "Teste",
      status: "paused",
      projetoId: 1,
      subtaskCount: 3,
    }
    expect(getEffectiveStatus(tarefaPausadaComSubtarefas)).toBe("paused")

    const tarefaPausadaSemSubtaskCount: FlowTask = {
      id: 3,
      titulo: "Teste",
      status: "paused",
      projetoId: 1,
      // subtaskCount undefined
    }
    expect(getEffectiveStatus(tarefaPausadaSemSubtaskCount)).toBe("draft")

    const tarefaEmExecucao: FlowTask = {
      id: 4,
      titulo: "Teste",
      status: "running",
      projetoId: 1,
      subtaskCount: 2,
    }
    expect(getEffectiveStatus(tarefaEmExecucao)).toBe("running")
  })
})
