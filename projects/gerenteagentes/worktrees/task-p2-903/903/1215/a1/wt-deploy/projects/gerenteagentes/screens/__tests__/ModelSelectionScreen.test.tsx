// @vitest-environment jsdom
/**
 * Testes da ModelSelectionScreen (task-54 + combos do console em task-66/st-2):
 * - renderiza o seletor de tipo (DEV/ANALYST/MONITOR)
 * - carrega entradas via GET no proxy e busca modelos via GET /gerenteagentes/modelos-console
 * - combos provider/model populados com os modelos do console (model filtrado pelo provider)
 * - trocar o provider encadeia: zera o model e repopula as opções
 * - entradas salvas com valores legados continuam editáveis (opção "(legado)")
 * - console indisponível (erro no GET modelos) → aviso + tela segue funcional
 * - permite adicionar/remover/reordenar entradas
 * - Salvar chama PUT no proxy e recarrega a resposta
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import ModelSelectionScreen from "../ModelSelectionScreen"

// Mock do useApi (bundle fake) — a tela não fala HTTP direto.
vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))
// Mock do useAuth — fornece o slug do projeto logado (projectKey).
vi.mock("../../../../apps/web/src/auth/AuthContext", () => ({
  useAuth: () => ({ projeto: { id: 42, nome: "Gerente", slug: "gerenteagentes", perfil: "admin" } }),
}))

type RespostaModelos = { models?: unknown[] } | unknown[]

/** Resultados roteados por path — zero `Once` (lição Vitest 4, 19/08). */
let filaSelecao: Array<Record<string, unknown>> = []
let modelosDoConsole: RespostaModelos = { models: [] }
let modelosDeveFalhar = false
let putSelecao: Record<string, unknown> | null = null

const mockRequest = vi.fn((method: string, path: string) => {
  if (path === "/gerenteagentes/modelos-console") {
    if (modelosDeveFalhar) {
      return Promise.reject(new Error("Console OpenClaw indisponível (503)"))
    }
    return Promise.resolve(modelosDoConsole)
  }
  if (method === "GET" && path.startsWith("/gerenteagentes/model-selection/")) {
    const proxima = filaSelecao.shift()
    return Promise.resolve(proxima ?? { projectKey: "gerenteagentes", tipo: "DEV", entries: [] })
  }
  if (method === "PUT" && path.startsWith("/gerenteagentes/model-selection/")) {
    return Promise.resolve(putSelecao ?? {
      projectKey: "gerenteagentes",
      tipo: "DEV",
      entries: [],
    })
  }
  return Promise.resolve({})
})

declare global {
  var __bundleFalso: unknown
}

function bundleFalso() {
  return {
    http: {
      request: (method: string, path: string, opts?: { body?: unknown }) =>
        mockRequest(method, path, opts),
    },
  } as never
}

beforeEach(() => {
  mockRequest.mockReset()
  filaSelecao = []
  modelosDoConsole = { models: [] }
  modelosDeveFalhar = false
  putSelecao = null
  globalThis.__bundleFalso = bundleFalso()
})

/**
 * MUI 7 select nativo + user-event (lição 19/08 + ajuste 21/08): o testid
 * dado no `<Select>` (via prop direta) cai no input NATIVO escondido (opacity 0,
 * pointer-events: none). O alvo clicável é o span `role=combobox` que antecede
 * esse input. As opções só existem no Popover (role=option, data-value) após
 * abrir o menu.
 */
function acharCombobox(input: HTMLElement): HTMLElement {
  const combobox = input.previousElementSibling
  if (!combobox || combobox.getAttribute("role") !== "combobox") {
    throw new Error(
      "combobox do campo não encontrado (esperado span role=combobox antes do input): " +
        input.getAttribute("data-testid"),
    )
  }
  return combobox as HTMLElement
}

function opcaoPorValor(valor: string): HTMLElement | undefined {
  return screen.queryAllByRole("option").find((o) => o.getAttribute("data-value") === valor)
}

async function escolherOpcao(
  user: ReturnType<typeof userEvent.setup>,
  inputTestId: string,
  valor: string,
) {
  const combobox = acharCombobox(screen.getByTestId(inputTestId) as HTMLInputElement)
  await user.click(combobox)
  const opcao = opcaoPorValor(valor)
  if (!opcao) throw new Error("opção não encontrada: " + valor)
  await user.click(opcao)
  await user.keyboard("{Escape}")
}

describe("ModelSelectionScreen", () => {
  it("renderiza seletor de tipo e carrega entradas (estado vazio) + busca modelos do console", async () => {
    modelosDoConsole = { models: [{ id: "m1", name: "Modelo Um", provider: "ollama" }] }
    render(<ModelSelectionScreen />)

    await waitFor(() => {
      expect(screen.getByTestId("select-tipo")).toBeInTheDocument()
    })
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    // Buscou o tipo DEV do projeto (slug)
    expect(mockRequest).toHaveBeenCalledWith(
      "GET",
      "/gerenteagentes/model-selection/gerenteagentes/DEV",
      { auth: "access" },
    )
    // E buscou os modelos do console (proxy)
    expect(mockRequest).toHaveBeenCalledWith("GET", "/gerenteagentes/modelos-console", { auth: "access" })
  })

  it("combos provider/model populados com os modelos do console (model filtrado pelo provider)", async () => {
    modelosDoConsole = {
      models: [
        { id: "qwen3.8:27b", name: "Qwen 3.8 27B", provider: "ollama" },
        { id: "llama3.3:70b", name: "Llama 3.3 70B", provider: "ollama" },
        { id: "gpt-5.6", name: "GPT-5.6", provider: "openai" },
      ],
    }
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    const row1 = screen.getByTestId("entry-row-1")

    // Abre o combo provider: lista ollama e openai
    await user.click(acharCombobox(within(row1).getByTestId("entry-provider-1") as HTMLInputElement))
    expect(opcaoPorValor("ollama")).toBeTruthy()
    expect(opcaoPorValor("openai")).toBeTruthy()
    const opOllama = opcaoPorValor("ollama")
    if (!opOllama) throw new Error("opção ollama ausente")
    await user.click(opOllama)
    await user.keyboard("{Escape}")

    // Combo model filtrado: só modelos do ollama
    await user.click(acharCombobox(within(row1).getByTestId("entry-model-1") as HTMLInputElement))
    expect(opcaoPorValor("qwen3.8:27b")).toBeTruthy()
    expect(opcaoPorValor("llama3.3:70b")).toBeTruthy()
    expect(opcaoPorValor("gpt-5.6")).toBeUndefined()
    const opQwen = opcaoPorValor("qwen3.8:27b")
    if (!opQwen) throw new Error("opção qwen ausente")
    await user.click(opQwen)
    await user.keyboard("{Escape}")

    // provider + model preenchidos automaticamente
    await waitFor(() => {
      expect(within(row1).getByTestId("entry-provider-1")).toHaveValue("ollama")
    })
    expect(within(row1).getByTestId("entry-model-1")).toHaveValue("qwen3.8:27b")
  })

  it("trocar o provider encadeia: zera o model e repopula as opções", async () => {
    modelosDoConsole = {
      models: [
        { id: "qwen3.8:27b", name: "Qwen 3.8 27B", provider: "ollama" },
        { id: "gpt-5.6", name: "GPT-5.6", provider: "openai" },
      ],
    }
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    const row1 = screen.getByTestId("entry-row-1")

    // provider ollama + model qwen
    await escolherOpcao(user, "entry-provider-1", "ollama")
    await escolherOpcao(user, "entry-model-1", "qwen3.8:27b")
    expect(within(row1).getByTestId("entry-model-1")).toHaveValue("qwen3.8:27b")

    // troca para openai → model zerado e só gpt-5.6 disponível
    await escolherOpcao(user, "entry-provider-1", "openai")
    await waitFor(() => {
      expect(within(row1).getByTestId("entry-model-1")).toHaveValue("")
    })
    await user.click(acharCombobox(within(row1).getByTestId("entry-model-1") as HTMLInputElement))
    expect(opcaoPorValor("gpt-5.6")).toBeTruthy()
    expect(opcaoPorValor("qwen3.8:27b")).toBeUndefined()
    await user.keyboard("{Escape}")
  })

  it("entradas salvas com valores legados continuam editáveis (opção (legado))", async () => {
    modelosDoConsole = { models: [{ id: "m1", name: "Novo", provider: "ollama" }] }
    filaSelecao = [
      {
        projectKey: "gerenteagentes",
        tipo: "DEV",
        entries: [{ ordem: 1, provider: "provider-antigo", model: "modelo-antigo", enabled: true }],
      },
    ]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("entry-row-1")).toBeInTheDocument())
    const row1 = screen.getByTestId("entry-row-1")
    expect(within(row1).getByTestId("entry-provider-1")).toHaveValue("provider-antigo")
    expect(within(row1).getByTestId("entry-model-1")).toHaveValue("modelo-antigo")

    // Combo provider: a opção legado aparece (e o provider do console)
    await user.click(acharCombobox(within(row1).getByTestId("entry-provider-1") as HTMLInputElement))
    expect(opcaoPorValor("provider-antigo")).toBeTruthy()
    expect(opcaoPorValor("ollama")).toBeTruthy()
    const opLegado = opcaoPorValor("provider-antigo")
    if (!opLegado) throw new Error("opção legado ausente")
    await user.click(opLegado)
    await user.keyboard("{Escape}")
    expect(within(row1).getByTestId("entry-provider-1")).toHaveValue("provider-antigo")

    // Combo model: a opção legado aparece selecionável
    await escolherOpcao(user, "entry-model-1", "modelo-antigo")
    expect(within(row1).getByTestId("entry-model-1")).toHaveValue("modelo-antigo")
  })

  it("console indisponível (erro no GET modelos) → aviso + tela segue funcional", async () => {
    modelosDeveFalhar = true
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    render(<ModelSelectionScreen />)

    // O erro do console NÃO derruba a tela: aviso específico aparece e a fila carrega.
    await waitFor(() => {
      expect(screen.getByTestId("no-console-models")).toBeInTheDocument()
    })
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()

    // A tela continua permitindo adicionar entradas
    const user = userEvent.setup()
    await user.click(screen.getByTestId("btn-add"))
    expect(screen.getByTestId("entry-row-1")).toBeInTheDocument()
  })

  it("aceita resposta do console em formato array direto", async () => {
    modelosDoConsole = [{ id: "m1", name: "Modelo Um", provider: "ollama" }]
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    const row1 = screen.getByTestId("entry-row-1")
    await user.click(acharCombobox(within(row1).getByTestId("entry-provider-1") as HTMLInputElement))
    expect(opcaoPorValor("ollama")).toBeTruthy()
    await user.keyboard("{Escape}")
  })

  it("adicionar e remover entradas", async () => {
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    expect(screen.getByTestId("entry-row-1")).toBeInTheDocument()

    await user.click(screen.getByTestId("btn-add"))
    expect(screen.getByTestId("entry-row-2")).toBeInTheDocument()

    await user.click(screen.getByTestId("entry-remove-2"))
    expect(screen.queryByTestId("entry-row-2")).not.toBeInTheDocument()
    expect(screen.getByTestId("entry-row-1")).toBeInTheDocument()
  })

  it("Salvar chama PUT no proxy e recarrega a resposta", async () => {
    modelosDoConsole = {
      models: [
        { id: "qwen3.8:27b", name: "Qwen 3.8 27B", provider: "ollama" },
      ],
    }
    filaSelecao = [{ projectKey: "gerenteagentes", tipo: "DEV", entries: [] }]
    putSelecao = {
      projectKey: "gerenteagentes",
      tipo: "DEV",
      entries: [{ ordem: 1, provider: "ollama", model: "qwen3.8:27b", enabled: true }],
    }
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    expect(screen.getByTestId("entry-row-1")).toBeInTheDocument()

    await escolherOpcao(user, "entry-provider-1", "ollama")
    await escolherOpcao(user, "entry-model-1", "qwen3.8:27b")

    const btnSalvar = screen.getByTestId("btn-save")
    expect(btnSalvar).toBeEnabled()
    await user.click(btnSalvar)

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "PUT",
        "/gerenteagentes/model-selection/gerenteagentes/DEV",
        {
          auth: "access",
          body: { entries: [{ ordem: 1, provider: "ollama", model: "qwen3.8:27b", enabled: true }] },
        },
      )
    })
    // Recarrega a resposta e mostra aviso de sucesso
    await waitFor(() => expect(screen.getByTestId("success-alert")).toBeInTheDocument())
  })

  it("usa o slug do projeto pai clicado (parentRow) em vez do slug logado", async () => {
    modelosDoConsole = { models: [] }
    render(
      <ModelSelectionScreen
        parentRow={{ id: 7, nome: "Biblioteca Global", slug: "biblioteca-global" }}
      />,
    )

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "GET",
        "/gerenteagentes/model-selection/biblioteca-global/DEV",
        { auth: "access" },
      )
    })
    // Cabeçalho exibe o projeto da linha clicada
    expect(screen.getByText(/Biblioteca Global \(biblioteca-global\)/)).toBeInTheDocument()
  })

  it("salvar envia PUT com o slug do projeto pai clicado (parentRow)", async () => {
    modelosDoConsole = {
      models: [{ id: "qwen3.8:27b", name: "Qwen 3.8 27B", provider: "ollama" }],
    }
    filaSelecao = [{ projectKey: "biblioteca-global", tipo: "DEV", entries: [] }]
    putSelecao = {
      projectKey: "biblioteca-global",
      tipo: "DEV",
      entries: [{ ordem: 1, provider: "ollama", model: "qwen3.8:27b", enabled: true }],
    }
    const user = userEvent.setup()
    render(
      <ModelSelectionScreen
        parentRow={{ id: 7, nome: "Biblioteca Global", slug: "biblioteca-global" }}
      />,
    )

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    await user.click(screen.getByTestId("btn-add"))
    await escolherOpcao(user, "entry-provider-1", "ollama")
    await escolherOpcao(user, "entry-model-1", "qwen3.8:27b")
    await user.click(screen.getByTestId("btn-save"))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "PUT",
        "/gerenteagentes/model-selection/biblioteca-global/DEV",
        {
          auth: "access",
          body: { entries: [{ ordem: 1, provider: "ollama", model: "qwen3.8:27b", enabled: true }] },
        },
      )
    })
    await waitFor(() => expect(screen.getByTestId("success-alert")).toBeInTheDocument())
  })

  it("trocar de tipo recarrega a fila (mantendo modelos do console)", async () => {
    modelosDoConsole = { models: [{ id: "m1", name: "Novo", provider: "ollama" }] }
    filaSelecao = [
      { projectKey: "gerenteagentes", tipo: "DEV", entries: [] },
      {
        projectKey: "gerenteagentes",
        tipo: "ANALYST",
        entries: [{ ordem: 1, provider: "ollama", model: "m1", enabled: true }],
      },
    ]
    const user = userEvent.setup()
    render(<ModelSelectionScreen />)

    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
    const tipoInput = screen.getByTestId("select-tipo") as HTMLInputElement
    await act(async () => {
      await user.click(acharCombobox(tipoInput))
      const opAnalyst = screen.queryAllByRole("option").find((o) => o.getAttribute("data-value") === "ANALYST")
      if (!opAnalyst) throw new Error("opção ANALYST ausente")
      await user.click(opAnalyst)
      await user.keyboard("{Escape}")
    })

    await waitFor(() => {
      expect(screen.getByTestId("entry-row-1")).toBeInTheDocument()
    })
    expect(within(screen.getByTestId("entry-row-1")).getByTestId("entry-provider-1")).toHaveValue("ollama")
    expect(within(screen.getByTestId("entry-row-1")).getByTestId("entry-model-1")).toHaveValue("m1")
  })
})
