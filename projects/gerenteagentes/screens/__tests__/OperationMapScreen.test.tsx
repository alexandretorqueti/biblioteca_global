// @vitest-environment jsdom
/**
 * Testes das ações destrutivas do Mapa de agentes (OperationMapScreen).
 *
 * Bug reportado: "não achei o botão de excluir ou de cancelar na tela mapa do
 * agente". O cancelamento/exclusão existiam apenas na tela "Acompanhar Tarefa";
 * aqui garantimos que o detalhe da tarefa no Mapa exponha os dois botões e que
 * eles chamem os endpoints operacionais do motor:
 *
 *   POST   /gerenteagentes/tarefas/:id/cancel  → interrupção imediata
 *   DELETE /gerenteagentes/tarefas/:id         → exclusão definitiva
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import OperationMapScreen from "../OperationMapScreen"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleMapa ?? undefined,
}))

/**
 * O RealtimeClient abre WebSocket; no jsdom não há servidor. O componente só
 * precisa do contrato `connect/close` — o estado realtime é irrelevante aqui.
 */
vi.mock("@biblioteca-global/api-client", () => ({
  RealtimeClient: class {
    options: { channel?: string; onMessage?: (message: unknown) => void }
    constructor(options: { channel?: string; onMessage?: (message: unknown) => void }) {
      this.options = options
      const state = globalThis as typeof globalThis & { __mapRealtimeInstances?: Array<{ options: typeof options }> }
      ;(state.__mapRealtimeInstances ??= []).push({ options })
    }
    connect(): void {
      /* no-op nos testes */
    }
    close(): void {
      /* no-op nos testes */
    }
  },
}))

interface TarefaFake {
  id: number
  titulo: string
  status: string
  projetoId: number
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
    descricao: null,
    dependsOnTaskId: null,
    createdAt: "2026-09-13T12:00:00Z",
    updatedAt: "2026-09-13T12:00:00Z",
  }
}

/** Bundle fake: registra as chamadas e devolve payloads mínimos válidos. */
function bundleFalso(tarefas: TarefaFake[], chamadas: string[]) {
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (
        method: string,
        path: string,
        config?: { body?: unknown },
      ) => {
        chamadas.push(`${method} ${path} ${JSON.stringify(config?.body ?? {})}`)
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") {
          return { items: [{ id: 1, nome: "Projeto X" }] }
        }
        if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") {
          return { canStart: true, reasons: [], pendingRequests: 0 }
        }
        if (path.endsWith("/motor-detail")) {
          return { motorId: "m1", exists: false, message: "Não enviada" }
        }
        if (path.endsWith("/subtarefas")) return []
        if (path.endsWith("/chat")) return []
        if (path.endsWith("/duracoes")) return {
          tarefaId: 7,
          geradoEm: "2026-09-13T13:00:00Z",
          totalSegundos: 6045,
          atividades: [
            { tipo: "analise_ia", rotulo: "IA analisando", segundos: 4820, intervalos: [{ inicio: "2026-09-13T12:00:00Z", fim: "2026-09-13T13:20:20Z", detalhe: "modelo X" }] },
            { tipo: "testes", rotulo: "Testes", segundos: 600, intervalos: [{ inicio: "2026-09-13T13:20:20Z", fim: "2026-09-13T13:30:20Z", phase: "post_dev" }] },
            { tipo: "fila", rotulo: "Fila/espera", segundos: 45, intervalos: [{ inicio: "2026-09-13T13:30:20Z", fim: "2026-09-13T13:31:05Z", subtarefa: "Subtarefa 1", estimado: true }] },
          ],
        }
        return {}
      },
    },
  }
}

function renderScreen() {
  return render(
    <BibliotecaThemeProvider>
      <OperationMapScreen />
    </BibliotecaThemeProvider>,
  )
}

/** Abre o detalhe da tarefa clicando no marcador do canvas. */
async function abrirDetalhe(taskId: number) {
  await screen.findByTestId(`operation-map-task-${taskId}`)
  // Deixa os carregamentos assíncronos (detalhe/subtarefas/chat/atividades)
  // assentarem antes de clicar — o canvas é re-renderizado algumas vezes.
  await waitFor(() =>
    expect(screen.getByTestId(`operation-map-task-${taskId}`)).toBeInTheDocument(),
  )
  fireEvent.click(screen.getByTestId(`operation-map-task-${taskId}`))
  return screen.findByTestId("btn-cancel")
}

describe("OperationMapScreen — cancelar e excluir tarefa", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.spyOn(window, "prompt").mockReturnValue("motivo de teste")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
  })

  it("exibe Cancelar e Excluir no detalhe da tarefa", async () => {
    globalThis.__bundleMapa = bundleFalso(
      [tarefaFactory(7, "Tarefa do mapa", "paused")],
      [],
    )
    renderScreen()
    await abrirDetalhe(7)
    expect(screen.getByTestId("btn-cancel")).toBeEnabled()
    expect(screen.getByTestId("btn-delete")).toBeEnabled()
  })

  it("exibe erro quando as opções de dependência falham", async () => {
    let statusCalls = 0
    globalThis.__bundleMapa = {
      ...bundleFalso([tarefaFactory(7, "Tarefa do mapa", "paused")], []),
      http: {
        request: async (method: string, path: string, config?: { body?: unknown }) => {
          if (path === "/gerenteagentes/tarefas-com-status") {
            statusCalls += 1
            if (statusCalls > 1) throw new Error("Falha ao consultar dependências")
          }
          return bundleFalso([tarefaFactory(7, "Tarefa do mapa", "paused")], []).http.request(method, path, config)
        },
      },
    }
    renderScreen()
    await abrirDetalhe(7)
    await userEvent.click(screen.getByText("Editar"))

    expect(await screen.findByText("Falha ao consultar dependências")).toBeInTheDocument()
  })

  it("Cancelar chama POST /cancel com o motivo informado", async () => {
    const chamadas: string[] = []
    globalThis.__bundleMapa = bundleFalso(
      [tarefaFactory(7, "Tarefa do mapa", "paused")],
      chamadas,
    )
    renderScreen()
    await userEvent.click(await abrirDetalhe(7))

    await waitFor(() =>
      expect(
        chamadas.some(c => c.startsWith("POST /gerenteagentes/tarefas/7/cancel")),
      ).toBe(true),
    )
    expect(chamadas.find(c => c.includes("/cancel"))).toContain(
      "motivo de teste",
    )
  })

  it("Excluir chama DELETE /tarefas/:id e fecha o detalhe", async () => {
    const chamadas: string[] = []
    globalThis.__bundleMapa = bundleFalso(
      [tarefaFactory(7, "Tarefa do mapa", "paused")],
      chamadas,
    )
    renderScreen()
    await abrirDetalhe(7)
    await userEvent.click(screen.getByTestId("btn-delete"))

    await waitFor(() =>
      expect(
        chamadas.some(c => c.startsWith("DELETE /gerenteagentes/tarefas/7")),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("btn-delete")).not.toBeInTheDocument(),
    )
  })

  it("não oferece cancelar/excluir para tarefa já finalizada e desabilita excluir em execução", async () => {
    globalThis.__bundleMapa = bundleFalso(
      [
        tarefaFactory(1, "Concluída", "completed"),
        tarefaFactory(2, "Em execução", "running"),
      ],
      [],
    )
    renderScreen()

    // Tarefa finalizada: cancelar fica desabilitado.
    await abrirDetalhe(1)
    expect(screen.getByTestId("btn-cancel")).toBeDisabled()
    // Retorna ao mapa para selecionar a próxima.
    await userEvent.click(screen.getByLabelText("Fechar detalhe"))

    // Tarefa em execução: excluir fica desabilitado (evita apagar dado vivo).
    await abrirDetalhe(2)
    expect(screen.getByTestId("btn-delete")).toBeDisabled()
  })
})

describe("OperationMapScreen — aba de durações", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
  })

  it("carrega durações somente ao abrir a aba e exibe valores e barras", async () => {
    const chamadas: string[] = []
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(7, "Tarefa do mapa", "completed")], chamadas)
    renderScreen()
    await abrirDetalhe(7)

    expect(chamadas.some(c => c.includes("/duracoes"))).toBe(false)
    fireEvent.click(screen.getByRole("tab", { name: "Durações" }))

    expect(await screen.findByTestId("operation-durations")).toBeInTheDocument()
    expect(chamadas.filter(c => c.includes("/duracoes"))).toHaveLength(1)
    expect(screen.getByText("Total: 1h 40min")).toBeInTheDocument()
    expect(screen.getByText("1h 20min")).toBeInTheDocument()
    expect(screen.getByText("10min")).toBeInTheDocument()
    expect(screen.getByText("45s")).toBeInTheDocument()
    expect(screen.getAllByRole("progressbar")).toHaveLength(3)
  })
})

describe("OperationMapScreen — tarefas enfileiradas", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
  })

  it("exibe no mapa tarefas planejadas aguardando a fila do Motor v3", async () => {
    globalThis.__bundleMapa = bundleFalso(
      [tarefaFactory(88, "Tarefa aguardando consumidor", "planned")],
      [],
    )

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("operation-map-task-88")).toBeInTheDocument()
      expect(screen.getByTestId("operation-count-planned")).toHaveTextContent("1")
    })
  })
})

describe("OperationMapScreen — atividade do motor via WebSocket", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
    delete (globalThis as typeof globalThis & { __mapRealtimeInstances?: unknown }).__mapRealtimeInstances
  })

  it("atualiza os quatro quadros ao receber motor.activity.updated no canal map", async () => {
    globalThis.__bundleMapa = bundleFalso([tarefaFactory(42, "Tarefa realtime", "running")], [])
    renderScreen()

    await waitFor(() => {
      const instances = (globalThis as typeof globalThis & { __mapRealtimeInstances?: Array<{ options: { channel?: string; onMessage?: (message: unknown) => void } }> }).__mapRealtimeInstances ?? []
      expect(instances.some(instance => instance.options.channel === "map")).toBe(true)
    })
    const mapInstance = ((globalThis as typeof globalThis & { __mapRealtimeInstances: Array<{ options: { channel?: string; onMessage?: (message: unknown) => void } }> }).__mapRealtimeInstances).findLast(instance => instance.options.channel === "map")!
    mapInstance.options.onMessage?.({
      type: "event",
      event: {
        type: "motor.activity.updated",
        payload: {
          motor: {
            isActive: true,
            isRunning: true,
            activity: { kind: "git", message: "operação git da tarefa 42", taskIds: ["42", "43"] },
          },
          workers: [
            { role: "analyst", active: true, taskId: "42", subtaskId: 7, phase: "analysis" },
            { role: "developer", active: true, taskId: "43", subtaskId: 8, phase: "executing" },
            { role: "manager", active: true, taskId: "44", subtaskId: null, phase: "monitor" },
          ],
        },
      }})

    expect(await screen.findByTestId("agent-task-code-analyst")).toHaveTextContent("#42 · S7")
    expect(screen.getByTestId("agent-task-code-developer")).toHaveTextContent("#43 · S8")
    expect(screen.getByTestId("agent-task-code-manager")).toHaveTextContent("#44")
    expect(screen.getByTestId("motor-state-box")).toHaveTextContent("Realizando operações git")
    expect(screen.getByTestId("motor-git-task-42")).toBeInTheDocument()
    expect(screen.getByTestId("motor-git-task-43")).toBeInTheDocument()
  })
})

describe("OperationMapScreen — resultado da subtarefa na aba Execução", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
  })

  function bundleComSubtarefas(tarefaId: number, subtarefas: Array<Record<string, unknown>>) {
    return {
      getAccessToken: () => "token-de-teste",
      http: {
        request: async (method: string, path: string) => {
          if (path === "/gerenteagentes/tarefas-com-status") return [tarefaFactory(tarefaId, "Tarefa com resultado", "running")]
          if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
          if (path === "/gerenteagentes/motor-activity") return { activities: [], workers: [] }
          if (path === "/gerenteagentes/motor-deploy-diagnostics") return { canStart: true, reasons: [], pendingRequests: 0 }
          if (path.endsWith("/motor-detail")) {
            return {
              motorId: "m1",
              exists: true,
              task: { status: "running", title: "Tarefa com resultado" },
              subtasks: subtarefas.map(s => ({
                seq: s.seq,
                title: s.titulo,
                status: s.status,
                resultado: s.resultado,
                blockInfo: s.blockInfo,
                deliverCount: 1,
                scope: "Escopo",
                acceptanceCriteria: [],
                currentModel: s.currentModel ?? null,
                modelHistory: s.modelHistory ?? [],
              })),
            }
          }
          if (path.endsWith("/subtarefas")) return []
          if (path.endsWith("/chat")) return []
          return {}
        },
      },
    }
  }

  async function abrirAbaExecucao(taskId: number) {
    await screen.findByTestId(`operation-map-task-${taskId}`)
    await waitFor(() =>
      expect(screen.getByTestId(`operation-map-task-${taskId}`)).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId(`operation-map-task-${taskId}`))
    // Aguarda o drawer abrir
    await screen.findByTestId("operation-task-drawer")
    // Clica na aba "Execução" (índice 2)
    const tabs = screen.getAllByRole("tab")
    fireEvent.click(tabs[2])
  }

  it("exibe resultado em branco dentro de uma caixa rolável", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(10, [
      { seq: 1, titulo: "Subtarefa concluída", status: "completed", resultado: "Implementação finalizada com sucesso." },
    ])
    renderScreen()
    await abrirAbaExecucao(10)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveTextContent("Resultado: Implementação finalizada com sucesso.")
    const estilo = getComputedStyle(resultado)
    expect(estilo.color).toBe("rgb(255, 255, 255)")
    expect(estilo.maxHeight).toBe("220px")
    expect(estilo.overflowY).toBe("auto")
    expect(estilo.borderTopWidth).toBe("1px")
    expect(estilo.borderTopStyle).toBe("solid")
  })

  it("mantém o resultado branco quando a subtarefa falha", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(11, [
      { seq: 1, titulo: "Subtarefa com falha", status: "failed", resultado: "Erro de compilação no módulo X." },
    ])
    renderScreen()
    await abrirAbaExecucao(11)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveTextContent("Resultado: Erro de compilação no módulo X.")
    expect(getComputedStyle(resultado).color).toBe("rgb(255, 255, 255)")
  })

  it("mantém o resultado branco quando a subtarefa é verificada", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(12, [
      { seq: 1, titulo: "Subtarefa verificada", status: "verified", resultado: "Testes passaram, revisão aprovada." },
    ])
    renderScreen()
    await abrirAbaExecucao(12)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(getComputedStyle(resultado).color).toBe("rgb(255, 255, 255)")
  })

  it("mantém o resultado branco quando a subtarefa está bloqueada", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(13, [
      { seq: 1, titulo: "Subtarefa bloqueada", status: "blocked", resultado: "Dependência externa não disponível." },
    ])
    renderScreen()
    await abrirAbaExecucao(13)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(getComputedStyle(resultado).color).toBe("rgb(255, 255, 255)")
  })

  it("exibe o motivo do bloqueio ativo abaixo da subtarefa", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(15, [
      { seq: 1, titulo: "Subtarefa bloqueada", status: "blocked", resultado: null, blockInfo: { reason: "Aguardando credencial do ambiente." } },
      { seq: 2, titulo: "Outra subtarefa", status: "pending", resultado: null },
    ])
    renderScreen()
    await abrirAbaExecucao(15)

    expect(await screen.findByTestId("subtask-block-1")).toHaveTextContent("Motivo do bloqueio: Aguardando credencial do ambiente.")
    expect(screen.queryByTestId("subtask-block-2")).not.toBeInTheDocument()
    expect(screen.queryByTestId("subtask-result-1")).not.toBeInTheDocument()
  })

  it("aplica tipografia sans-serif e tamanho aumentado no resultado", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(14, [
      { seq: 1, titulo: "Subtarefa", status: "completed", resultado: "Texto de teste." },
    ])
    renderScreen()
    await abrirAbaExecucao(14)

    const resultado = await screen.findByTestId("subtask-result-1")
    // 0.9375rem = 15px (1pt acima do body2 padrão de 14px).
    const estilo = getComputedStyle(resultado)
    expect(estilo.fontSize).toBe("15px")
    expect(estilo.lineHeight).toBe("1.6")
  })

  it("exibe o modelo atual na subtarefa em andamento com sessão ativa", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(16, [
      {
        seq: 1, titulo: "Subtarefa em execução", status: "running", resultado: null,
        currentModel: "ollama/qwen3.8:27b-mtp-q8_0",
        modelHistory: [{ id: 201, model: "ollama/qwen3.8:27b-mtp-q8_0", purpose: "development", status: "active", openedAt: "2026-11-24T10:00:00Z", lastActivityAt: "2026-11-24T10:20:00Z", closedAt: null }],
      },
    ])
    renderScreen()
    await abrirAbaExecucao(16)

    expect(await screen.findByTestId("subtask-current-model-1")).toHaveTextContent("Modelo atual: ollama/qwen3.8:27b-mtp-q8_0")
    // Em andamento não exibe o bloco de histórico.
    expect(screen.queryByTestId("subtask-model-history-1")).not.toBeInTheDocument()
  })

  it("exibe indicador de modelo desconhecido quando a subtarefa está em andamento sem sessão ativa", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(17, [
      { seq: 1, titulo: "Subtarefa sem sessão", status: "running", resultado: null, currentModel: null, modelHistory: [] },
    ])
    renderScreen()
    await abrirAbaExecucao(17)

    expect(await screen.findByTestId("subtask-current-model-1")).toHaveTextContent("Modelo atual: desconhecido")
  })

  it("exibe o histórico de modelos na subtarefa concluída (mais recente primeiro)", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(18, [
      {
        seq: 1, titulo: "Subtarefa concluída", status: "completed", resultado: null, currentModel: null,
        modelHistory: [
          { id: 202, model: "deepseek/deepseek-v4-flash", purpose: "development", status: "failed", openedAt: "2026-11-24T08:00:00Z", lastActivityAt: "2026-11-24T08:30:00Z", closedAt: "2026-11-24T08:31:00Z" },
          { id: 201, model: "ollama/qwen3.8:27b-mtp-q8_0", purpose: "development", status: "completed", openedAt: "2026-11-24T07:00:00Z", lastActivityAt: "2026-11-24T07:40:00Z", closedAt: "2026-11-24T07:41:00Z" },
        ],
      },
    ])
    renderScreen()
    await abrirAbaExecucao(18)

    const historico = await screen.findByTestId("subtask-model-history-1")
    expect(historico).toHaveTextContent("Modelos que trabalharam nesta subtarefa (mais recente primeiro):")
    expect(historico).toHaveTextContent("deepseek/deepseek-v4-flash")
    expect(historico).toHaveTextContent("ollama/qwen3.8:27b-mtp-q8_0")
    expect(historico).toHaveTextContent("failed")
    expect(historico).toHaveTextContent("development")
    // Mais recente primeiro: o chip da sessão 202 vem antes da 201.
    expect(historico.textContent!.indexOf("deepseek/deepseek-v4-flash")).toBeLessThan(historico.textContent!.indexOf("ollama/qwen3.8:27b-mtp-q8_0"))
    // Concluída não exibe o campo de modelo atual.
    expect(screen.queryByTestId("subtask-current-model-1")).not.toBeInTheDocument()
  })

  it("exibe indicador de ausência de sessões para subtarefa bloqueada sem histórico", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(19, [
      { seq: 1, titulo: "Subtarefa bloqueada sem sessões", status: "blocked", resultado: null, blockInfo: { reason: "Sem ambiente" }, currentModel: null, modelHistory: [] },
    ])
    renderScreen()
    await abrirAbaExecucao(19)

    expect(await screen.findByTestId("subtask-model-history-1")).toHaveTextContent("Nenhuma sessão registrada para esta subtarefa.")
    expect(screen.queryByTestId("subtask-current-model-1")).not.toBeInTheDocument()
  })
})
