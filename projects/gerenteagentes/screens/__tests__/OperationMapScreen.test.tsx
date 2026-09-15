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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
    constructor(options: { onMessage?: (message: unknown) => void }) {
      globalThis.__mapaRealtimeOnMessage = options.onMessage
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
        if (path === "/gerenteagentes/motor-activity") return { activities: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") {
          return { canStart: true, reasons: [], pendingRequests: 0 }
        }
        if (path.endsWith("/motor-detail")) {
          return { motorId: "m1", exists: false, message: "Não enviada" }
        }
        if (path.endsWith("/subtarefas")) return []
        if (path.endsWith("/chat")) return []
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

interface DbSubtaskContract {
  id: number
  seq: number
  titulo: string
  status: string
  scope: string
  acceptanceCriteria: string[]
  resultado: string | null
  dependsOnSubtaskId: number | null
}

function subtaskContract(overrides: Partial<DbSubtaskContract> = {}): DbSubtaskContract {
  return {
    id: 31,
    seq: 1,
    titulo: "Título antigo",
    status: "pending",
    scope: "Escopo antigo",
    acceptanceCriteria: ["Critério antigo"],
    resultado: null,
    dependsOnSubtaskId: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** Contrato do mapa: PUT devolve a subtarefa persistida, e GET pode chegar fora de ordem. */
function bundleComLeiturasConcorrentes(
  initial: DbSubtaskContract,
  staleReadStarted: () => void,
  staleRead: Promise<DbSubtaskContract[]>,
  putBody: { current?: unknown },
) {
  let current = initial
  let subtasksReads = 0
  const tarefas = [tarefaFactory(7, "Tarefa do mapa", "paused")]
  return {
    getAccessToken: () => "token-de-teste",
    http: {
      request: async (method: string, path: string, config?: { body?: unknown }) => {
        if (path === "/gerenteagentes/tarefas-com-status") return tarefas
        if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
        if (path === "/gerenteagentes/motor-activity") return { activities: [] }
        if (path === "/gerenteagentes/motor-deploy-diagnostics") return { canStart: true, reasons: [], pendingRequests: 0 }
        if (path.endsWith("/motor-detail")) return { motorId: "m1", exists: false, message: "Não enviada" }
        if (path.endsWith("/chat")) return []
        if (method === "GET" && path.endsWith("/subtarefas")) {
          subtasksReads += 1
          if (subtasksReads === 2) {
            staleReadStarted()
            return staleRead
          }
          return [current]
        }
        if (method === "PUT" && path === `/gerenteagentes/subtarefas/${initial.id}`) {
          putBody.current = config?.body
          current = subtaskContract(config?.body as Partial<DbSubtaskContract>)
          return current
        }
        return {}
      },
    },
  }
}

describe("OperationMapScreen — cancelar e excluir tarefa", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    vi.spyOn(window, "prompt").mockReturnValue("motivo de teste")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
    delete globalThis.__mapaRealtimeOnMessage
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

  it("mantém no mapa a resposta confirmada do PUT quando uma leitura antiga chega depois", async () => {
    const user = userEvent.setup()
    const oldSubtask = subtaskContract()
    const oldRead = deferred<DbSubtaskContract[]>()
    const putBody: { current?: unknown } = {}
    let staleReadStarted = false
    globalThis.__bundleMapa = bundleComLeiturasConcorrentes(
      oldSubtask,
      () => { staleReadStarted = true },
      oldRead.promise,
      putBody,
    )

    renderScreen()
    await abrirDetalhe(7)
    await user.click(screen.getByRole("tab", { name: "Execução" }))
    expect(await screen.findByText("Título antigo")).toBeInTheDocument()

    // Simula o refresh disparado por um evento do motor; esta resposta fica pendente.
    await act(async () => {
      globalThis.__mapaRealtimeOnMessage?.({
        type: "event",
        event: { type: "subtask.updated", payload: {}, occurredAt: "2026-09-15T12:00:00Z" },
      })
    })
    await waitFor(() => expect(staleReadStarted).toBe(true))

    await user.click(screen.getByLabelText("Editar subtarefa 1"))
    const dialog = await screen.findByRole("dialog", { name: "Editar subtarefa" })
    const titleInput = within(dialog).getByLabelText("Título")
    await user.clear(titleInput)
    await user.type(titleInput, "Novo título confirmado")
    await user.click(within(dialog).getByRole("button", { name: /Salvar alterações/i }))

    await waitFor(() => expect(putBody.current).toEqual(expect.objectContaining({
      titulo: "Novo título confirmado",
      status: "pending",
      seq: 1,
      scope: "Escopo antigo",
      acceptance_criteria: ["Critério antigo"],
      resultado: null,
      dependsOnSubtaskId: null,
    })))
    // A fonte renderizada é dbSubtasks (o motor-detail informa exists=false).
    expect(await screen.findByText("Novo título confirmado")).toBeInTheDocument()

    // A resposta antiga não pode sobrescrever a edição já confirmada pelo PUT.
    await act(async () => { oldRead.resolve([oldSubtask]) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.getByText("Novo título confirmado")).toBeInTheDocument()
    expect(screen.queryByText("Título antigo")).not.toBeInTheDocument()
  })
})
