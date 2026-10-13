// @vitest-environment jsdom
/**
 * Testes da aba PROVIDERS da tela CONFIGURAÇÕES (task-p2-995, subtarefa 3):
 * - a aba "Providers" existe ao lado de Parâmetros/MODELOS (tab id padrão "providers")
 * - ao abrir a aba, consome GET /gerenteagentes/providers-limites e exibe uma
 *   linha por provider, na mesma ordem da resposta (mesma fonte da tela de modelos)
 * - campos numéricos carregam valores salvos; null aparece vazio
 * - Salvar por provider chama PUT /gerenteagentes/providers-limites/:provider
 *   com os três campos (vazio = null) e feedback de sucesso
 * - erro do backend (ex.: 403 de RBAC) aparece como alerta de erro
 * - valor inválido (fora de 1–100) bloqueia o envio com erro local
 * - abas Parâmetros e MODELOS sem regressão
 */
import { describe, expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import ConfiguracoesScreen from "../ConfiguracoesScreen"

// Mock do useApi (bundle fake) — a tela não fala HTTP direto.
vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => globalThis.__bundleFalso ?? undefined,
}))

type ProviderRow = {
  provider: string
  limiteExecucaoTotal: number | null
  limiteAnalises: number | null
  limiteDesenvolvimento: number | null
}

type ConfigRow = {
  chave: string
  tipo: "number" | "string" | "boolean"
  valor: number | string | boolean
  valorPadrao: number | string | boolean
  regraValidacao: string
  descricao: string
  editavel: boolean
  atualizadoEm: string | null
}

let providersRows: ProviderRow[] = []
let configuracoesRows: ConfigRow[] = []
let putProviderResponder: ((provider: string, body: Record<string, number | null>) => unknown) | null = null

const mockRequest = vi.fn((method: string, path: string, opts?: { body?: unknown }) => {
  if (method === "GET" && path === "/gerenteagentes/configuracoes") {
    return Promise.resolve(configuracoesRows)
  }
  if (method === "GET" && path === "/gerenteagentes/providers-limites") {
    return Promise.resolve(providersRows)
  }
  if (method === "GET" && path === "/gerenteagentes/model-selection/global") {
    return Promise.resolve({ configuracaoGlobal: { DEV: [], ANALYST: [], MONITOR: [] } })
  }
  if (method === "GET" && path === "/gerenteagentes/modelos-console") {
    return Promise.resolve({ models: [] })
  }
  if (method === "PUT" && path.startsWith("/gerenteagentes/providers-limites/")) {
    const provider = decodeURIComponent(path.split("/").pop() ?? "")
    const body = (opts?.body ?? {}) as Record<string, number | null>
    const resposta = putProviderResponder
      ? putProviderResponder(provider, body)
      : { provider, ...body }
    return resposta instanceof Error ? Promise.reject(resposta) : Promise.resolve(resposta)
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
  providersRows = []
  configuracoesRows = []
  putProviderResponder = null
  globalThis.__bundleFalso = bundleFalso()
})

async function abrirAbaProviders() {
  const user = userEvent.setup()
  const tabs = await waitFor(() => screen.getByTestId("configuracoes-tabs"))
  await user.click(within(tabs).getByTestId("aba-providers"))
  await waitFor(() => expect(screen.getByTestId("configuracoes-providers")).toBeInTheDocument())
  return user
}

describe("ConfiguracoesScreen — aba Providers", () => {
  it("exibe a aba Providers ao lado de Parâmetros e MODELOS", async () => {
    render(<ConfiguracoesScreen />)
    const tabs = await waitFor(() => screen.getByTestId("configuracoes-tabs"))
    expect(within(tabs).getByTestId("aba-parametros")).toBeInTheDocument()
    expect(within(tabs).getByTestId("aba-modelos")).toBeInTheDocument()
    const abaProviders = within(tabs).getByTestId("aba-providers")
    expect(abaProviders).toBeInTheDocument()
    expect(abaProviders).toHaveTextContent("Providers")
    // painel providers ainda não montou (aba inicial é Parâmetros)
    expect(screen.queryByTestId("configuracoes-providers")).not.toBeInTheDocument()
  })

  it("ao abrir a aba, consome GET /providers-limites e lista um provider por linha (mesma ordem)", async () => {
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: null, limiteDesenvolvimento: null },
      { provider: "alibaba", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
      { provider: "openai", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()
    void user

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("GET", "/gerenteagentes/providers-limites", { auth: "access" })
    })
    await waitFor(() => {
      expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument()
      expect(screen.getByTestId("providers-row-alibaba")).toBeInTheDocument()
      expect(screen.getByTestId("providers-row-openai")).toBeInTheDocument()
    })

    const painel = screen.getByTestId("providers-rows-panel")
    const nomes = within(painel)
      .getAllByTestId(/^providers-nome-/)
      .map((el) => el.textContent)
    expect(nomes).toEqual(["ollama", "alibaba", "openai"])

    // três campos por provider, com os rótulos da spec
    for (const tid of ["ollama", "alibaba", "openai"]) {
      const row = within(screen.getByTestId(`providers-row-${tid}`))
      expect(row.getByTestId(`providers-input-limiteExecucaoTotal-${tid}`)).toBeInTheDocument()
      expect(row.getByTestId(`providers-input-limiteAnalises-${tid}`)).toBeInTheDocument()
      expect(row.getByTestId(`providers-input-limiteDesenvolvimento-${tid}`)).toBeInTheDocument()
      expect(row.getByLabelText("Execuções paralelas (máx.) — " + tid)).toBeInTheDocument()
      expect(row.getByLabelText("Análises paralelas (máx.) — " + tid)).toBeInTheDocument()
      expect(row.getByLabelText("Desenvolvimentos paralelos (máx.) — " + tid)).toBeInTheDocument()
      expect(row.getByTestId(`providers-btn-salvar-${tid}`)).toBeInTheDocument()
    }
  })

  it("carrega valores salvos e deixa vazios os não configurados (null → campo vazio)", async () => {
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: 2, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)
    await abrirAbaProviders()

    await waitFor(() => expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument())
    const row = within(screen.getByTestId("providers-row-ollama"))
    expect(row.getByTestId("providers-input-limiteExecucaoTotal-ollama")).toHaveValue(1)
    expect(row.getByTestId("providers-input-limiteAnalises-ollama")).toHaveValue(2)
    expect(row.getByTestId("providers-input-limiteDesenvolvimento-ollama")).toHaveValue(null)
  })

  it("lista vazia → aviso amigável sem erro", async () => {
    providersRows = []
    render(<ConfiguracoesScreen />)
    await abrirAbaProviders()
    await waitFor(() => expect(screen.getByTestId("providers-empty")).toBeInTheDocument())
  })

  it("salvar envia PUT por provider com os três campos (vazio = null) e mostra sucesso", async () => {
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: 2, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()

    await waitFor(() => expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument())
    const row = within(screen.getByTestId("providers-row-ollama"))
    const inputDesenvolvimento = row.getByTestId("providers-input-limiteDesenvolvimento-ollama") as HTMLInputElement

    await user.clear(inputDesenvolvimento)
    await user.type(inputDesenvolvimento, "3")

    await user.click(row.getByTestId("providers-btn-salvar-ollama"))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "PUT",
        "/gerenteagentes/providers-limites/ollama",
        {
          auth: "access",
          body: { limiteExecucaoTotal: 1, limiteAnalises: 2, limiteDesenvolvimento: 3 },
        },
      )
    })
    await waitFor(() => expect(screen.getByTestId("providers-success")).toBeInTheDocument())
    expect(screen.queryByTestId("providers-error")).not.toBeInTheDocument()
    // recarrega a linha com a resposta persistida
    await waitFor(() => {
      expect(within(screen.getByTestId("providers-row-ollama")).getByTestId("providers-input-limiteDesenvolvimento-ollama")).toHaveValue(3)
    })
  })

  it("campo limpo é enviado como null (remove a restrição)", async () => {
    providersRows = [
      { provider: "alibaba", limiteExecucaoTotal: 5, limiteAnalises: 2, limiteDesenvolvimento: 1 },
    ]
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()

    await waitFor(() => expect(screen.getByTestId("providers-row-alibaba")).toBeInTheDocument())
    const row = within(screen.getByTestId("providers-row-alibaba"))
    await user.clear(row.getByTestId("providers-input-limiteExecucaoTotal-alibaba"))
    await user.clear(row.getByTestId("providers-input-limiteAnalises-alibaba"))
    await user.click(row.getByTestId("providers-btn-salvar-alibaba"))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "PUT",
        "/gerenteagentes/providers-limites/alibaba",
        {
          auth: "access",
          body: { limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: 1 },
        },
      )
    })
  })

  it("erro ao salvar (ex.: RBAC 403) mostra alerta de erro devolvido pela API", async () => {
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
    ]
    putProviderResponder = () => new Error("Sem permissão para esta operação (403)")
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()

    await waitFor(() => expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument())
    await user.click(within(screen.getByTestId("providers-row-ollama")).getByTestId("providers-btn-salvar-ollama"))

    await waitFor(() => expect(screen.getByTestId("providers-error")).toBeInTheDocument())
    expect(screen.getByTestId("providers-error")).toHaveTextContent("Sem permissão")
    expect(screen.queryByTestId("providers-success")).not.toBeInTheDocument()
  })

  it("valor fora de 1–100 bloqueia o envio com erro local (sem PUT)", async () => {
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()

    await waitFor(() => expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument())
    const row = within(screen.getByTestId("providers-row-ollama"))
    await user.clear(row.getByTestId("providers-input-limiteExecucaoTotal-ollama"))
    await user.type(row.getByTestId("providers-input-limiteExecucaoTotal-ollama"), "0")
    await user.click(row.getByTestId("providers-btn-salvar-ollama"))

    await waitFor(() => expect(screen.getByTestId("providers-error")).toBeInTheDocument())
    expect(screen.getByTestId("providers-error")).toHaveTextContent("Valor inválido")
    expect(mockRequest).not.toHaveBeenCalledWith(
      "PUT",
      "/gerenteagentes/providers-limites/ollama",
      expect.anything(),
    )
  })

  it("provider com caracteres especiais no nome é enviado codificado no PUT", async () => {
    providersRows = [
      { provider: "openrouter/claude", limiteExecucaoTotal: null, limiteAnalises: null, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)
    const user = await abrirAbaProviders()

    const tid = "openrouter-claude"
    await waitFor(() => expect(screen.getByTestId(`providers-row-${tid}`)).toBeInTheDocument())
    await user.click(within(screen.getByTestId(`providers-row-${tid}`)).getByTestId(`providers-btn-salvar-${tid}`))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith(
        "PUT",
        "/gerenteagentes/providers-limites/openrouter%2Fclaude",
        expect.objectContaining({ auth: "access" }),
      )
    })
  })

  it("abas Parâmetros e MODELOS sem regressão (painéis continuam montando)", async () => {
    configuracoesRows = [
      {
        chave: "motor.max_workers",
        tipo: "number",
        valor: 4,
        valorPadrao: 4,
        regraValidacao: "inteiro entre 1 e 100",
        descricao: "Total geral de execuções paralelas",
        editavel: true,
        atualizadoEm: null,
      },
    ]
    providersRows = [
      { provider: "ollama", limiteExecucaoTotal: 1, limiteAnalises: null, limiteDesenvolvimento: null },
    ]
    render(<ConfiguracoesScreen />)

    // aba inicial Parâmetros renderiza a config existente (testid cai na raiz do TextField; o input é filho)
    await waitFor(() => expect(screen.getByTestId("configuracao-motor.max_workers")).toBeInTheDocument())
    const inputMaxWorkers = within(screen.getByTestId("config-input-motor.max_workers")).getByRole("spinbutton")
    expect(inputMaxWorkers).toHaveValue(4)

    const user = userEvent.setup()
    const tabs = screen.getByTestId("configuracoes-tabs")

    // MODELOS carrega o painel global
    await user.click(within(tabs).getByTestId("aba-modelos"))
    await waitFor(() => expect(screen.getByTestId("configuracoes-modelos")).toBeInTheDocument())
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("GET", "/gerenteagentes/model-selection/global", { auth: "access" })
    })

    // Providers abre e mostra os limites
    await user.click(within(tabs).getByTestId("aba-providers"))
    await waitFor(() => expect(screen.getByTestId("providers-row-ollama")).toBeInTheDocument())

    // de volta para Parâmetros: sem regressão
    await user.click(within(tabs).getByTestId("aba-parametros"))
    await waitFor(() => expect(screen.getByTestId("configuracao-motor.max_workers")).toBeInTheDocument())
  })
})
