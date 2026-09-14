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
