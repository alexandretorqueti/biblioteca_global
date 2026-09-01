// @vitest-environment jsdom
/**
 * Testes do botão Editar e diálogo de edição no TaskMonitorScreen.
 *
 * ST-1 task-95: botão EditRounded ao lado do título → Dialog com DynamicForm
 * → PUT /tarefas/:id → sucesso fecha diálogo + recarrega; erro exibe Alert.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"

import TaskMonitorScreen from "../TaskMonitorScreen"

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

const mockFetch = vi.fn()

function tarefaFactory(
  id: number,
  titulo: string,
  status: string,
  projetoId: number,
  extra?: { descricao?: string | null; dependsOnTaskId?: number | null },
) {
  return {
    id,
    titulo,
    status,
    projetoId,
    descricao: extra?.descricao ?? null,
    dependsOnTaskId: extra?.dependsOnTaskId ?? null,
    createdAt: "2026-08-24T12:00:00Z",
    updatedAt: "2026-08-24T12:00:00Z",
  } as const
}

function projetoFactory(id: number, nome: string) {
  return { id, nome, slug: `proj-${id}`, ativo: true } as const
}

/**
 * Bundle fake: roteia por method+path.
 * - GET /projetos_captados → lista de projetos
 * - GET /tarefas → lista de tarefas
 * - GET /gerenteagentes/tarefas/:id/motor-detail → motorDetail
 * - PUT /tarefas/:id → controlado por `putResult`
 */
function bundleFalso(opts?: {
  projetos?: unknown[]
  tarefas?: unknown[]
  motorDetail?: unknown
  putResult?: { ok: boolean; status: number; body?: unknown }
}) {
  const projetos = opts?.projetos ?? [projetoFactory(1, "Projeto X")]
  const tarefas = opts?.tarefas ?? [tarefaFactory(1, "Tarefa A", "draft", 1)]
  const motorDetail = opts?.motorDetail ?? { motorId: "m1", exists: false, message: "Não enviada" }
  const putResult = opts?.putResult ?? { ok: true, status: 200, body: { ok: true } }

  return {
    http: {
      request: async (method: string, path: string) => {
        if (method === "GET" && path === "/projetos_captados") {
          return { items: projetos }
        }
        if (method === "GET" && path === "/tarefas") {
          return { items: tarefas }
        }
        if (method === "GET" && path.startsWith("/gerenteagentes/tarefas/") && path.endsWith("/motor-detail")) {
          return motorDetail
        }
        if (method === "PUT" && path.startsWith("/tarefas/")) {
          if (!putResult.ok) {
            const body = putResult.body as { message?: string } | undefined
            throw new Error(body?.message ?? `HTTP ${putResult.status}`)
          }
          return putResult.body
        }
        // fallback
        return {}
      },
    },
  } as never
}

describe("TaskMonitorScreen — ST-1 (botão editar + diálogo)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    // Avançar o fake timer dos intervalos de polling
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete globalThis.__bundleFalso
  })

  function renderScreen() {
    return render(
      <BibliotecaThemeProvider>
        <TaskMonitorScreen />
      </BibliotecaThemeProvider>,
    )
  }

  it("renderiza o botão EditRounded ao lado do título quando há tarefa selecionada", async () => {
    const tarefas = [tarefaFactory(1, "Minha Tarefa", "draft", 1)]
    globalThis.__bundleFalso = bundleFalso({ tarefas })

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("task-monitor-screen")).toBeInTheDocument()
    })

    // O título aparece
    expect(screen.getByText("Minha Tarefa")).toBeInTheDocument()

    // O botão de editar está visível
    const editBtn = screen.getByTestId("btn-edit-task")
    expect(editBtn).toBeInTheDocument()
    expect(editBtn).toHaveAttribute("aria-label", "Editar tarefa")
  })

  it("abre o Dialog com DynamicForm ao clicar no botão editar", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [
      tarefaFactory(1, "Tarefa Edit", "running", 1, {
        descricao: "Descrição atual",
        dependsOnTaskId: null,
      }),
    ]
    globalThis.__bundleFalso = bundleFalso({ tarefas })

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-task")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-task"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-task-dialog")).toBeInTheDocument()
    })

    // O DynamicForm está dentro do Dialog
    const dialog = screen.getByTestId("edit-task-dialog")
    expect(within(dialog).getByText("Editar tarefa")).toBeInTheDocument()

    // O campo título está preenchido com o valor atual
    const tituloInput = within(dialog).getByLabelText(/Título/)
    expect(tituloInput).toHaveValue("Tarefa Edit")
  })

  it("submete PUT /tarefas/:id com sucesso — fecha o diálogo", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(42, "Tarefa Original", "draft", 1)]
    const putSpy = vi.fn().mockResolvedValue({ ok: true })

    const bundle = {
      http: {
        request: async (method: string, path: string, reqOpts?: { body?: unknown }) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.startsWith("/gerenteagentes/tarefas/")) {
            return { motorId: "m1", exists: false, message: "Não enviada" }
          }
          if (method === "PUT" && path === "/tarefas/42") {
            putSpy(reqOpts?.body)
            return { ok: true }
          }
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-task")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-task"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-task-dialog")).toBeInTheDocument()
    })

    // Altera o título
    const dialog = screen.getByTestId("edit-task-dialog")
    const tituloInput = within(dialog).getByLabelText(/Título/)
    await user.clear(tituloInput)
    await user.type(tituloInput, "Tarefa Atualizada")

    // Submete
    const submitBtn = within(dialog).getByRole("button", { name: /Salvar alterações/i })
    await user.click(submitBtn)

    // Aguarda o Dialog fechar
    await waitFor(() => {
      expect(screen.queryByTestId("edit-task-dialog")).not.toBeInTheDocument()
    })

    // Verifica que o PUT foi chamado com os dados corretos
    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        titulo: "Tarefa Atualizada",
      }),
    )
  })

  it("exibe Alert de erro quando PUT falha", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(7, "Tarefa Erro", "draft", 1)]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.startsWith("/gerenteagentes/tarefas/")) {
            return { motorId: "m1", exists: false, message: "Não enviada" }
          }
          if (method === "PUT" && path === "/tarefas/7") {
            throw new Error("Campo inválido")
          }
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-task")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-task"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-task-dialog")).toBeInTheDocument()
    })

    const dialog = screen.getByTestId("edit-task-dialog")
    const submitBtn = within(dialog).getByRole("button", { name: /Salvar alterações/i })
    await user.click(submitBtn)

    // Aguarda o Alert de erro aparecer
    await waitFor(() => {
      expect(within(dialog).getByTestId("edit-error-alert")).toBeInTheDocument()
    })

    expect(within(dialog).getByTestId("edit-error-alert")).toHaveTextContent("Campo inválido")

    // O Dialog continua aberto (não fecha em erro)
    expect(screen.getByTestId("edit-task-dialog")).toBeInTheDocument()
  })

  it("fecha o Dialog ao clicar no botão de fechar", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa Close", "draft", 1)]
    globalThis.__bundleFalso = bundleFalso({ tarefas })

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-task")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-task"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-task-dialog")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-close-edit"))

    await waitFor(() => {
      expect(screen.queryByTestId("edit-task-dialog")).not.toBeInTheDocument()
    })
  })
})

describe("TaskMonitorScreen — ST-2 (editar subtarefa)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete globalThis.__bundleFalso
  })

  function renderScreen() {
    return render(
      <BibliotecaThemeProvider>
        <TaskMonitorScreen />
      </BibliotecaThemeProvider>,
    )
  }

  function subTarefaDbFactory(
    id: number,
    tarefaId: number,
    seq: number,
    titulo: string,
    status = "pending",
  ) {
    return {
      id,
      tarefaId,
      seq,
      titulo,
      status,
      descricao: null,
      resultado: null,
      dependsOnSubtaskId: null,
    } as const
  }

  it("renderiza botão EditRounded em cada linha da tabela de subtarefas", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [
        { seq: 1, title: "Sub 1", status: "pending" },
        { seq: 2, title: "Sub 2", status: "verified" },
      ],
      currentSubTask: { seq: 1, title: "Sub 1", status: "running" },
      events: [],
    }

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) {
            return [
              subTarefaDbFactory(10, 1, 1, "Sub 1"),
              subTarefaDbFactory(11, 1, 2, "Sub 2"),
            ]
          }
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-table")).toBeInTheDocument()
    })

    // Botões de editar devem aparecer em cada linha
    expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    expect(screen.getByTestId("btn-edit-subtask-2")).toBeInTheDocument()
    expect(screen.getByTestId("btn-edit-subtask-1")).toHaveAttribute("aria-label", "Editar subtarefa 1")
    expect(screen.getByTestId("btn-edit-subtask-2")).toHaveAttribute("aria-label", "Editar subtarefa 2")
  })

  it("abre Dialog com DynamicForm ao clicar em editar subtarefa", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [{ seq: 1, title: "Sub 1", status: "pending" }],
      currentSubTask: null,
      events: [],
    }
    const dbSub = subTarefaDbFactory(10, 1, 1, "Sub 1", "pending")

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return [dbSub]
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-subtask-1"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
    })

    const dialog = screen.getByTestId("edit-subtask-dialog")
    expect(within(dialog).getByText("Editar subtarefa #1")).toBeInTheDocument()

    // Campo título deve estar preenchido
    const tituloInput = within(dialog).getByLabelText(/Título/)
    expect(tituloInput).toHaveValue("Sub 1")
  })

  it("submete PUT /subtarefas/:id com sucesso — fecha diálogo", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [{ seq: 1, title: "Sub 1", status: "pending" }],
      currentSubTask: null,
      events: [],
    }
    const dbSub = subTarefaDbFactory(10, 1, 1, "Sub 1", "pending")
    const putSpy = vi.fn().mockResolvedValue({ ok: true })

    const bundle = {
      http: {
        request: async (method: string, path: string, reqOpts?: { query?: Record<string, unknown>; body?: unknown }) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return [dbSub]
          if (method === "PUT" && path === "/subtarefas/10") {
            putSpy(reqOpts?.body)
            return { ok: true }
          }
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-subtask-1"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
    })

    const dialog = screen.getByTestId("edit-subtask-dialog")
    const tituloInput = within(dialog).getByLabelText(/Título/)
    await user.clear(tituloInput)
    await user.type(tituloInput, "Sub 1 Atualizada")

    const submitBtn = within(dialog).getByRole("button", { name: /Salvar alterações/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(screen.queryByTestId("edit-subtask-dialog")).not.toBeInTheDocument()
    })

    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        titulo: "Sub 1 Atualizada",
        status: "pending",
        seq: 1,
      }),
    )
  })

  it("exibe Alert de erro quando PUT /subtarefas falha", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [{ seq: 1, title: "Sub 1", status: "pending" }],
      currentSubTask: null,
      events: [],
    }
    const dbSub = subTarefaDbFactory(10, 1, 1, "Sub 1", "pending")

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return [dbSub]
          if (method === "PUT" && path === "/subtarefas/10") {
            throw new Error("Campo inválido")
          }
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-subtask-1"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
    })

    const dialog = screen.getByTestId("edit-subtask-dialog")
    const submitBtn = within(dialog).getByRole("button", { name: /Salvar alterações/i })
    await user.click(submitBtn)

    await waitFor(() => {
      expect(within(dialog).getByTestId("edit-sub-error-alert")).toBeInTheDocument()
    })

    expect(within(dialog).getByTestId("edit-sub-error-alert")).toHaveTextContent("Campo inválido")
    expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
  })

  it("exibe erro quando subtarefa do motor não existe no banco", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [{ seq: 1, title: "Sub 1", status: "pending" }],
      currentSubTask: null,
      events: [],
    }

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return [] // banco vazio
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-subtask-1"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
    })

    const dialog = screen.getByTestId("edit-subtask-dialog")
    expect(within(dialog).getByTestId("edit-sub-error-alert")).toBeInTheDocument()
    expect(within(dialog).getByTestId("edit-sub-error-alert")).toHaveTextContent(
      "Subtarefa ainda não sincronizada com o banco de dados",
    )
  })

  it("fecha Dialog ao clicar no botão de fechar", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [{ seq: 1, title: "Sub 1", status: "pending" }],
      currentSubTask: null,
      events: [],
    }
    const dbSub = subTarefaDbFactory(10, 1, 1, "Sub 1", "pending")

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return [dbSub]
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("btn-edit-subtask-1")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-edit-subtask-1"))

    await waitFor(() => {
      expect(screen.getByTestId("edit-subtask-dialog")).toBeInTheDocument()
    })

    await user.click(screen.getByTestId("btn-close-edit-subtask"))

    await waitFor(() => {
      expect(screen.queryByTestId("edit-subtask-dialog")).not.toBeInTheDocument()
    })
  })
})

describe("TaskMonitorScreen — compatibilidade Motor-v2", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete globalThis.__bundleFalso
  })

  it("exibe as subtarefas persistidas quando o detalhe do Motor-v2 ainda vem sem elas", async () => {
    const tarefas = [tarefaFactory(727, "Teste fluxo real", "ready", 2)]
    const subtarefas = [
      { id: 711, tarefaId: 727, seq: 1, titulo: "Localizar o README correto", status: "rejected", descricao: null, resultado: null, dependsOnSubtaskId: null },
      { id: 714, tarefaId: 727, seq: 2, titulo: "Correção: Localizar o README correto", status: "rejected", descricao: null, resultado: null, dependsOnSubtaskId: null },
      { id: 715, tarefaId: 727, seq: 3, titulo: "Correção pendente", status: "pending", descricao: null, resultado: null, dependsOnSubtaskId: null },
    ]
    globalThis.__bundleFalso = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(2, "GerenteAgentes")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) {
            return {
              motorId: "727",
              exists: true,
              task: { id: "727", status: "ready", title: "Teste fluxo real" },
              subtasks: [],
              currentSubTask: null,
              events: [],
            }
          }
          if (method === "GET" && path.endsWith("/subtarefas")) return subtarefas
          return {}
        },
      },
    } as never

    render(
      <BibliotecaThemeProvider>
        <TaskMonitorScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("subtask-row-1")).toBeInTheDocument()
      expect(screen.getByTestId("subtask-row-3")).toBeInTheDocument()
    })
    expect(screen.getByTestId("task-progress")).toHaveTextContent("Progresso: 0 / 3")
    expect(screen.getByTestId("btn-start")).toBeDisabled()
  })

  it("permite iniciar tarefa planejada que já existe no motor", async () => {
    const tarefas = [tarefaFactory(727, "Tarefa planejada", "planned", 2)]
    globalThis.__bundleFalso = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(2, "GerenteAgentes")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) {
            return {
              motorId: "727",
              exists: true,
              task: { id: "727", status: "planned", title: "Tarefa planejada" },
              subtasks: [],
              currentSubTask: null,
              events: [],
            }
          }
          if (method === "GET" && path.endsWith("/subtarefas")) return []
          return {}
        },
      },
    } as never

    render(
      <BibliotecaThemeProvider>
        <TaskMonitorScreen />
      </BibliotecaThemeProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("btn-start")).toBeInTheDocument()
    })
    expect(screen.getByTestId("btn-start")).not.toBeDisabled()
    expect(screen.getByTestId("btn-pause")).toBeDisabled()
    expect(screen.getByTestId("btn-resume")).toBeDisabled()
  })
})

describe("TaskMonitorScreen — Lista de subtarefas (scope, critérios, workspace, correção)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch)
    mockFetch.mockReset()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete globalThis.__bundleFalso
  })

  function renderScreen() {
    return render(
      <BibliotecaThemeProvider>
        <TaskMonitorScreen />
      </BibliotecaThemeProvider>,
    )
  }

  function subTarefaDbFactory(
    id: number,
    tarefaId: number,
    seq: number,
    titulo: string,
    status = "pending",
    extra?: {
      scope?: string | null
      acceptanceCriteria?: unknown
      workspaceStatus?: string | null
      correctionForSubtaskId?: number | null
    },
  ) {
    return {
      id,
      tarefaId,
      seq,
      titulo,
      status,
      descricao: null,
      scope: extra?.scope ?? null,
      acceptanceCriteria: extra?.acceptanceCriteria ?? null,
      resultado: null,
      dependsOnSubtaskId: null,
      workspaceStatus: extra?.workspaceStatus ?? null,
      correctionForSubtaskId: extra?.correctionForSubtaskId ?? null,
    } as const
  }

  it("exibe scope truncado na lista e contador de critérios de aceite", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [
        {
          seq: 1,
          title: "Implementar login",
          status: "verified",
          scope: "Criar tela de login com validação de e-mail e senha, incluindo recuperação de senha e autenticação de dois fatores",
          acceptanceCriteria: ["Campo e-mail validado", "Senha com argon2id", "2FA via TOTP"],
          workspaceStatus: null,
          correctionForSubtaskId: null,
        },
        {
          seq: 2,
          title: "Sem scope",
          status: "pending",
          scope: null,
          acceptanceCriteria: null,
          workspaceStatus: null,
          correctionForSubtaskId: null,
        },
      ],
      currentSubTask: null,
      events: [],
    }
    const dbSubs = [
      subTarefaDbFactory(10, 1, 1, "Implementar login", "verified", {
        scope: "Criar tela de login com validação de e-mail e senha, incluindo recuperação de senha e autenticação de dois fatores",
        acceptanceCriteria: ["Campo e-mail validado", "Senha com argon2id", "2FA via TOTP"],
      }),
      subTarefaDbFactory(11, 1, 2, "Sem scope", "pending"),
    ]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return dbSubs
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-table")).toBeInTheDocument()
    })

    // Scope da sub 1 deve estar visível (truncado)
    const scopeText = screen.getByTestId("scope-text-1")
    expect(scopeText).toBeInTheDocument()
    expect(scopeText).toHaveTextContent("Criar tela de login")

    // Sub 2 sem scope exibe "—"
    expect(screen.getByTestId("subtask-row-2")).toBeInTheDocument()

    // Contador de critérios: sub 1 tem 3, sub 2 tem 0
    expect(screen.getByTestId("criteria-count-1")).toHaveTextContent("3")
    expect(screen.getByTestId("criteria-count-2")).toHaveTextContent("0")
  })

  it("acceptance_criteria ausente/null/string inválida não quebra a renderização", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [
        { seq: 1, title: "Null criteria", status: "pending", scope: null, acceptanceCriteria: null, workspaceStatus: null, correctionForSubtaskId: null },
        { seq: 2, title: "Undefined criteria", status: "pending", scope: null, acceptanceCriteria: undefined, workspaceStatus: null, correctionForSubtaskId: null },
        { seq: 3, title: "Invalid string", status: "pending", scope: null, acceptanceCriteria: "not-json", workspaceStatus: null, correctionForSubtaskId: null },
        { seq: 4, title: "Valid JSON array", status: "pending", scope: null, acceptanceCriteria: ["crit1", "crit2"], workspaceStatus: null, correctionForSubtaskId: null },
      ],
      currentSubTask: null,
      events: [],
    }
    const dbSubs = [
      subTarefaDbFactory(10, 1, 1, "Null criteria", "pending"),
      subTarefaDbFactory(11, 1, 2, "Undefined criteria", "pending"),
      subTarefaDbFactory(12, 1, 3, "Invalid string", "pending", { acceptanceCriteria: "not-json" }),
      subTarefaDbFactory(13, 1, 4, "Valid JSON array", "pending", { acceptanceCriteria: ["crit1", "crit2"] }),
    ]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return dbSubs
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-table")).toBeInTheDocument()
    })

    // Todos renderizam sem quebrar
    expect(screen.getByTestId("criteria-count-1")).toHaveTextContent("0")
    expect(screen.getByTestId("criteria-count-2")).toHaveTextContent("0")
    expect(screen.getByTestId("criteria-count-3")).toHaveTextContent("0")
    expect(screen.getByTestId("criteria-count-4")).toHaveTextContent("2")
  })

  it("exibe workspace_status como chip somente leitura quando presente", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [
        { seq: 1, title: "Com workspace", status: "running", scope: null, acceptanceCriteria: null, workspaceStatus: "dirty", correctionForSubtaskId: null },
        { seq: 2, title: "Sem workspace", status: "pending", scope: null, acceptanceCriteria: null, workspaceStatus: null, correctionForSubtaskId: null },
      ],
      currentSubTask: null,
      events: [],
    }
    const dbSubs = [
      subTarefaDbFactory(10, 1, 1, "Com workspace", "running", { workspaceStatus: "dirty" }),
      subTarefaDbFactory(11, 1, 2, "Sem workspace", "pending"),
    ]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return dbSubs
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-table")).toBeInTheDocument()
    })

    // Sub 1 tem workspace_status "dirty"
    expect(screen.getByTestId("workspace-status-1")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-status-1")).toHaveTextContent("dirty")

    // Sub 2 não tem workspace_status — exibe "—"
    expect(screen.queryByTestId("workspace-status-2")).not.toBeInTheDocument()
  })

  it("subtarefa corretiva exibe badge com vínculo para a subtarefa corrigida", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    // A subtarefa 2 é correção da subtarefa 1 (correctionForSubtaskId = 10, que é o id da sub 1 no banco)
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [
        { seq: 1, title: "Original", status: "rejected", scope: "Fazer X", acceptanceCriteria: ["crit1"], workspaceStatus: null, correctionForSubtaskId: null },
        { seq: 2, title: "Correção: Fazer X", status: "pending", scope: "Motivo: gate falhou por lint", acceptanceCriteria: ["crit1", "lint limpo"], workspaceStatus: null, correctionForSubtaskId: 10 },
      ],
      currentSubTask: null,
      events: [],
    }
    const dbSubs = [
      subTarefaDbFactory(10, 1, 1, "Original", "rejected", { scope: "Fazer X", acceptanceCriteria: ["crit1"] }),
      subTarefaDbFactory(11, 1, 2, "Correção: Fazer X", "pending", {
        scope: "Motivo: gate falhou por lint",
        acceptanceCriteria: ["crit1", "lint limpo"],
        correctionForSubtaskId: 10,
      }),
    ]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return dbSubs
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-table")).toBeInTheDocument()
    })

    // Badge de correção na sub 2 aponta para sub 1
    expect(screen.getByTestId("correction-badge-2")).toBeInTheDocument()
    expect(screen.getByTestId("correction-badge-2")).toHaveTextContent("Correção de #1")

    // Sub 1 não tem badge de correção
    expect(screen.queryByTestId("correction-badge-1")).not.toBeInTheDocument()
  })

  it("fallback do banco também exibe scope e critérios (motor-detail sem subtasks)", async () => {
    const tarefas = [tarefaFactory(1, "Tarefa", "running", 1)]
    const motorDetail = {
      motorId: "m1",
      exists: true,
      task: { id: "task-1", status: "running", title: "Tarefa" },
      subtasks: [], // motor sem subtarefas → fallback do banco
      currentSubTask: null,
      events: [],
    }
    const dbSubs = [
      subTarefaDbFactory(10, 1, 1, "Sub do banco", "pending", {
        scope: "Escopo via banco",
        acceptanceCriteria: ["critério A", "critério B"],
        workspaceStatus: "clean",
      }),
    ]

    const bundle = {
      http: {
        request: async (method: string, path: string) => {
          if (method === "GET" && path === "/projetos_captados") return { items: [projetoFactory(1, "P1")] }
          if (method === "GET" && path === "/tarefas") return { items: tarefas }
          if (method === "GET" && path.endsWith("/motor-detail")) return motorDetail
          if (method === "GET" && path.endsWith("/subtarefas")) return dbSubs
          return {}
        },
      },
    } as never

    globalThis.__bundleFalso = bundle

    renderScreen()

    await waitFor(() => {
      expect(screen.getByTestId("subtask-row-1")).toBeInTheDocument()
    })

    // Scope visível via fallback
    expect(screen.getByTestId("scope-text-1")).toHaveTextContent("Escopo via banco")
    // Critérios via fallback
    expect(screen.getByTestId("criteria-count-1")).toHaveTextContent("2")
    // Workspace via fallback
    expect(screen.getByTestId("workspace-status-1")).toHaveTextContent("clean")
  })
})
