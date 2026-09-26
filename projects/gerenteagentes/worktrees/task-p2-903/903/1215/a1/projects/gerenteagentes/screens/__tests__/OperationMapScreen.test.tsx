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

import OperationMapScreen, { resultadoCor } from "../OperationMapScreen"

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

describe("resultadoCor", () => {
  it("retorna success para status de sucesso", () => {
    expect(resultadoCor("verified")).toBe("success")
    expect(resultadoCor("completed")).toBe("success")
    expect(resultadoCor("delivered")).toBe("success")
  })

  it("retorna error para status de falha/bloqueio/rejeição", () => {
    expect(resultadoCor("rejected")).toBe("error")
    expect(resultadoCor("blocked")).toBe("error")
    expect(resultadoCor("failed")).toBe("error")
  })

  it("retorna text.secondary para demais status", () => {
    expect(resultadoCor("running")).toBe("text.secondary")
    expect(resultadoCor("pending")).toBe("text.secondary")
    expect(resultadoCor("analyzing")).toBe("text.secondary")
  })
})

describe("OperationMapScreen — resultado da subtarefa na aba Execução", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.__bundleMapa
  })

  function bundleComSubtarefas(tarefaId: number, subtarefas: Array<{ seq: number; titulo: string; status: string; resultado: string | null }>) {
    return {
      getAccessToken: () => "token-de-teste",
      http: {
        request: async (method: string, path: string) => {
          if (path === "/gerenteagentes/tarefas-com-status") return [tarefaFactory(tarefaId, "Tarefa com resultado", "running")]
          if (path === "/gerenteagentes/projetos_captados") return { items: [{ id: 1, nome: "Projeto X" }] }
          if (path === "/gerenteagentes/motor-activity") return { activities: [] }
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
                deliverCount: 1,
                scope: "Escopo",
                acceptanceCriteria: [],
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

  it("exibe resultado em verde para subtarefa com status completed", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(10, [
      { seq: 1, titulo: "Subtarefa concluída", status: "completed", resultado: "Implementação finalizada com sucesso." },
    ])
    renderScreen()
    await abrirAbaExecucao(10)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveTextContent("Resultado: Implementação finalizada com sucesso.")
    // MUI aplica a cor via classe CSS; verificamos o estilo computado ou a classe
    expect(resultado).toHaveStyle({ color: expect.stringContaining("success") })
  })

  it("exibe resultado em vermelho para subtarefa com status failed", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(11, [
      { seq: 1, titulo: "Subtarefa com falha", status: "failed", resultado: "Erro de compilação no módulo X." },
    ])
    renderScreen()
    await abrirAbaExecucao(11)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveTextContent("Resultado: Erro de compilação no módulo X.")
    expect(resultado).toHaveStyle({ color: expect.stringContaining("error") })
  })

  it("exibe resultado em verde para subtarefa com status verified", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(12, [
      { seq: 1, titulo: "Subtarefa verificada", status: "verified", resultado: "Testes passaram, revisão aprovada." },
    ])
    renderScreen()
    await abrirAbaExecucao(12)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveStyle({ color: expect.stringContaining("success") })
  })

  it("exibe resultado em vermelho para subtarefa com status blocked", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(13, [
      { seq: 1, titulo: "Subtarefa bloqueada", status: "blocked", resultado: "Dependência externa não disponível." },
    ])
    renderScreen()
    await abrirAbaExecucao(13)

    const resultado = await screen.findByTestId("subtask-result-1")
    expect(resultado).toBeInTheDocument()
    expect(resultado).toHaveStyle({ color: expect.stringContaining("error") })
  })

  it("aplica tipografia sans-serif e tamanho aumentado no resultado", async () => {
    globalThis.__bundleMapa = bundleComSubtarefas(14, [
      { seq: 1, titulo: "Subtarefa", status: "completed", resultado: "Texto de teste." },
    ])
    renderScreen()
    await abrirAbaExecucao(14)

    const resultado = await screen.findByTestId("subtask-result-1")
    // 0.9375rem = 15px (1pt acima do body2 padrão de 14px)
    expect(resultado).toHaveStyle({ fontSize: "0.9375rem" })
    expect(resultado).toHaveStyle({ lineHeight: "1.6" })
  })
})
