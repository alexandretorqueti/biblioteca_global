// @vitest-environment jsdom
/**
 * Testes da CalculadoraScreen (plano macro #6, posição 4/9 — REQ-F-002,
 * REQ-F-004, REQ-F-006, REQ-D-001, REQ-NF-001).
 *
 * Transporte mockado em duas camadas:
 * - `useApi()` → `http.request` falso (CRUD de índices — grava todo método
 *   chamado; o teste afirma que só existem GETs);
 * - `globalThis.fetch` → fonte SGS falsa (o resolvedor roda no navegador;
 *   DECISOES-COTACOES.md §7 previa esta reavaliação de CORS).
 * Nenhum teste faz rede. Cache do resolvedor limpo entre testes.
 */
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EntityRecord } from "@biblioteca-global/shared"
import CalculadoraScreen, {
  componentId,
  formatarBRL,
  formatarTaxaMensal,
  parsearNumeroInput,
  parsearPrazoAnos,
  taxaAnualDeCadastro,
} from "../screens/CalculadoraScreen"
import { calcularProjecao } from "../calculo/projecao"
import {
  anualizarTaxaDi,
  converterAnualParaMensal,
  limparCacheCotacoes,
} from "../cotacoes/resolverCotacoes"

const { fakeRequest } = vi.hoisted(() => ({
  fakeRequest: vi.fn(),
}))

vi.mock("../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => ({ http: { request: fakeRequest } }),
}))

vi.mock("../../../apps/web/src/auth/AuthContext", () => ({
  useAuth: () => ({ projeto: { slug: "calculadora-de-investimentos-gabriel" } }),
}))

/** Chamadas registradas no cliente HTTP da plataforma (método + path). */
const chamadasHttp: Array<{ method: unknown; path: unknown }> = []

const SLUG = "calculadora-de-investimentos-gabriel"

interface IndiceFixure extends EntityRecord {
  id: number
  nome: string
  sigla: string
  taxaAnual: string
  ordem: number
}

const INDICES_PADRAO: IndiceFixure[] = [
  { id: 1, nome: "CDI", sigla: "CDI", taxaAnual: "13.6500", ordem: 1 },
  { id: 3, nome: "IPCA", sigla: "IPCA", taxaAnual: "4.5000", ordem: 3 },
]

/**
 * O `Intl` pt-BR separa "R$" do número com NBSP (U+00A0); o matcher
 * `toHaveTextContent` do jest-dom normaliza o texto DO elemento (NBSP →
 * espaço) mas compara a STRING esperada cru. Helper normaliza o esperado
 * da mesma forma — a exibição real na tela continua sendo o formato Intl.
 */
function brlEsperado(valor: number): string {
  return formatarBRL(valor).replace(/\u00a0/g, " ")
}

/** Configura o CRUD GET de índices (resposta paginada fora de ordem — a tela reordena). */
function prepararLista(indices: readonly IndiceFixure[] = INDICES_PADRAO): void {
  fakeRequest.mockImplementation(
    async (method: unknown, path: unknown) => {
      chamadasHttp.push({ method, path })
      if (method === "GET" && String(path).endsWith("/indices")) {
        return {
          items: [...indices].reverse(),
          total: indices.length,
          page: 1,
          pageSize: 100,
        }
      }
      throw new Error(`chamada HTTP inesperada: ${String(method)} ${String(path)}`)
    },
  )
}

/** Resposta SGS fake no formato real `[{"data","valor"}]`. */
function corpoSgs(observacoes: Array<{ data: string; valor: string }>): string {
  return JSON.stringify(observacoes)
}

/** Mocka o fetch global (fonte SGS) gravando método e URL de cada chamada. */
function mockFetchSgs(
  corpo: string,
  opts: { ok?: boolean; status?: number } = {},
): { fn: ReturnType<typeof vi.fn>; chamadas: Array<{ url: string; method?: string }> } {
  const chamadas: Array<{ url: string; method?: string }> = []
  const fn = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input)
    chamadas.push({ url, method: init?.method })
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => corpo,
    }
  })
  vi.stubGlobal("fetch", fn)
  return { fn, chamadas }
}

/** Resposta SGS do CDI: taxa % ao dia (série 12). */
const CDI_DIA_0035 = corpoSgs([
  { data: "20/11/2026", valor: "0,0035" },
  { data: "21/11/2026", valor: "0.0035" },
])

async function selecionarIndice(sigla = "CDI"): Promise<void> {
  const combobox = await screen.findByRole("combobox")
  await userEvent.click(combobox)
  await userEvent.click(
    await screen.findByRole("option", {
      name: new RegExp(sigla, "i"),
    }),
  )
}

beforeEach(() => {
  chamadasHttp.length = 0
  fakeRequest.mockReset()
  limparCacheCotacoes()
  prepararLista()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("CalculadoraScreen — utilidades puras", () => {
  it("mantém o componentId contratual (config.ts/registry.ts não mudam)", () => {
    expect(componentId).toBe("calculadora-de-investimentos-gabriel-calculadora")
  })

  it("parseia números com vírgula decimal e rejeita lixo", () => {
    expect(parsearNumeroInput("1.234,5")).toBeNull() // "1.234.5" não é número
    expect(parsearNumeroInput("1234,5")).toBe(1234.5)
    expect(parsearNumeroInput("42")).toBe(42)
    expect(parsearNumeroInput("")).toBeNull()
    expect(parsearNumeroInput("abc")).toBeNull()
  })

  it("prazo só aceita inteiro ≥ 1", () => {
    expect(parsearPrazoAnos("1")).toBe(1)
    expect(parsearPrazoAnos("5")).toBe(5)
    expect(parsearPrazoAnos("0")).toBeNull()
    expect(parsearPrazoAnos("2,5")).toBeNull()
    expect(parsearPrazoAnos("")).toBeNull()
  })

  it("taxa do cadastro: só valores > 0 servem de fallback (default 0 não)", () => {
    expect(taxaAnualDeCadastro({ taxaAnual: "13.6500" })).toBe(13.65)
    expect(taxaAnualDeCadastro({ taxaAnual: "0" })).toBeNull()
    expect(taxaAnualDeCadastro({})).toBeNull()
  })

  it("formata BRL e taxa mensal em pt-BR", () => {
    expect(formatarBRL(1234.5)).toBe(
      new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(1234.5),
    )
    expect(formatarTaxaMensal(1)).toContain("ao mês")
  })
})

describe("CalculadoraScreen — formulário e resultado", () => {
  it("carrega os índices via GET do CRUD ordenados por ordem", async () => {
    render(<CalculadoraScreen />)
    const combobox = (await screen.findByRole("combobox")) as HTMLElement
    await userEvent.click(combobox)
    const opcoes = await screen.findAllByRole("option")
    // ordem: Nenhum (value "") , CDI (1), IPCA (3) — mesmo com o payload invertido.
    expect(opcoes.map((o) => o.textContent)).toEqual([
      "Nenhum (use taxa manual)",
      "CDI (CDI)",
      "IPCA (IPCA)",
    ])
    expect(fakeRequest).toHaveBeenCalledWith(
      "GET",
      `/${SLUG}/indices`,
      expect.objectContaining({
        query: expect.objectContaining({ orderBy: "ordem:asc" }),
      }),
    )
  })

  it("sem taxa definida não exibe resultado", async () => {
    render(<CalculadoraScreen />)
    expect(await screen.findByTestId("valor-final")).toHaveTextContent("—")
    expect(screen.getByTestId("taxa-mensal")).toHaveTextContent("—")
  })

  it("taxa manual define resultado em R$ recalculado a cada mudança, sem índice", async () => {
    render(<CalculadoraScreen />)
    const taxaInput = await screen.findByLabelText(/Taxa manual/i)
    await userEvent.type(taxaInput, "12")
    // 1000 a 12% a.a. em 1 ano → 1120 (deps: valor padrão 1000, prazo 1).
    const esperado = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 1,
      taxaAnualPercentual: 12,
    })
    expect(screen.getByTestId("valor-final")).toHaveTextContent(
      brlEsperado(esperado.valorFinal),
    )
    // Recalculo instantâneo ao mudar o aporte (sem botão de submissão).
    await userEvent.clear(screen.getByLabelText(/depósito único/i))
    await userEvent.type(screen.getByLabelText(/depósito único/i), "2000")
    const esperado2 = calcularProjecao({
      modo: "unico",
      valorInicial: 2000,
      prazoAnos: 1,
      taxaAnualPercentual: 12,
    })
    await waitFor(() =>
      expect(screen.getByTestId("valor-final")).toHaveTextContent(
        brlEsperado(esperado2.valorFinal),
      ),
    )
  })

  it("alternar único/mensal troca o campo e o modo de cálculo", async () => {
    render(<CalculadoraScreen />)
    await screen.findByLabelText(/depósito único/i)
    await userEvent.click(screen.getByRole("button", { name: /Aportes mensais/i }))
    expect(screen.getByLabelText(/Aporte mensal/i)).toBeInTheDocument()
    expect(
      screen.queryByLabelText(/depósito único/i),
    ).not.toBeInTheDocument()

    await userEvent.type(await screen.findByLabelText(/Taxa manual/i), "12")
    const esperado = calcularProjecao({
      modo: "mensal",
      aporteMensal: 100, // valor padrão do campo
      prazoAnos: 1,
      taxaAnualPercentual: 12,
    })
    expect(esperado.valorFinal).not.toBeCloseTo(0, 5)
    await waitFor(() =>
      expect(screen.getByTestId("valor-final")).toHaveTextContent(
        brlEsperado(esperado.valorFinal),
      ),
    )
  })

  it("selecionar índice dispara GET de cotação e exibe apenas a taxa mensal", async () => {
    const { chamadas } = mockFetchSgs(CDI_DIA_0035)
    render(<CalculadoraScreen />)
    await selecionarIndice("CDI")

    const taxaAnualFonte = anualizarTaxaDi(0.0035)
    const taxaMensalFonte = converterAnualParaMensal(taxaAnualFonte)
    await waitFor(() =>
      expect(screen.getByTestId("taxa-mensal")).toHaveTextContent(
        formatarTaxaMensal(taxaMensalFonte),
      ),
    )
    // Busca automática executada no navegador contra a SGS (GET).
    expect(chamadas.length).toBe(1)
    expect(chamadas[0]?.url).toContain("api.bcb.gov.br")
    expect(chamadas[0]?.method ?? "GET").toBe("GET")
    // Valor final coerente com a taxa mensal da fonte.
    const esperado = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 1,
      taxaMensalPercentual: taxaMensalFonte,
    })
    expect(screen.getByTestId("valor-final")).toHaveTextContent(
      brlEsperado(esperado.valorFinal),
    )
    // RF-6: a taxa exibida é a mensal — a anual da fonte NÃO aparece como taxa.
    expect(screen.getByTestId("taxa-mensal").textContent).not.toContain(
      taxaAnualFonte.toFixed(2),
    )
  })

  it("taxa manual tem precedência sobre a cotação do índice", async () => {
    const { fn: fetchFn, chamadas } = mockFetchSgs(CDI_DIA_0035)
    render(<CalculadoraScreen />)
    await selecionarIndice("CDI")
    await waitFor(() => expect(chamadas.length).toBe(1))
    const taxaCotacao = converterAnualParaMensal(anualizarTaxaDi(0.0035))
    expect(screen.getByTestId("taxa-mensal")).toHaveTextContent(
      formatarTaxaMensal(taxaCotacao),
    )

    await userEvent.type(await screen.findByLabelText(/Taxa manual/i), "12")
    const taxaManual = converterAnualParaMensal(12)
    await waitFor(() =>
      expect(screen.getByTestId("taxa-mensal")).toHaveTextContent(
        formatarTaxaMensal(taxaManual),
      ),
    )
    // Resultado reflete a taxa manual (1000 → 1120 em 1 ano), não a cotação.
    const esperado = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 1,
      taxaAnualPercentual: 12,
    })
    expect(screen.getByTestId("valor-final")).toHaveTextContent(
      brlEsperado(esperado.valorFinal),
    )
    // Com taxa manual preenchida, nenhuma nova busca de cotação é disparada.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("estados de carregamento e sucesso da cotação", async () => {
    let resolverFetch!: (resposta: {
      ok: boolean
      status: number
      text: () => Promise<string>
    }) => void
    const fetchFn = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
          (resolver) => {
            resolverFetch = resolver
          },
        ),
    )
    vi.stubGlobal("fetch", fetchFn)

    render(<CalculadoraScreen />)
    await selecionarIndice("CDI")
    expect(await screen.findByTestId("carregando-cotacao")).toBeInTheDocument()

    resolverFetch({
      ok: true,
      status: 200,
      text: async () => CDI_DIA_0035,
    })
    const taxaMensalFonte = converterAnualParaMensal(anualizarTaxaDi(0.0035))
    await waitFor(() =>
      expect(screen.getByTestId("taxa-mensal")).toHaveTextContent(
        formatarTaxaMensal(taxaMensalFonte),
      ),
    )
    await waitFor(() =>
      expect(screen.queryByTestId("carregando-cotacao")).not.toBeInTheDocument(),
    )
  })

  it("falha da fonte com taxa no cadastro usa fallback com indicação visual", async () => {
    mockFetchSgs("", { ok: false, status: 503 })
    render(<CalculadoraScreen />)
    await selecionarIndice("CDI")

    expect(await screen.findByTestId("alerta-fallback")).toBeInTheDocument()
    const taxaMensalFallback = converterAnualParaMensal(13.65) // taxaAnual do cadastro
    await waitFor(() =>
      expect(screen.getByTestId("taxa-mensal")).toHaveTextContent(
        formatarTaxaMensal(taxaMensalFallback),
      ),
    )
  })

  it("erro tipado de cotação sem fallback não derruba a tela", async () => {
    prepararLista([{ id: 9, nome: "Selic", sigla: "SELIC", taxaAnual: "0", ordem: 2 }])
    mockFetchSgs("", { ok: false, status: 500 })
    render(<CalculadoraScreen />)
    await selecionarIndice("SELIC")

    const alerta = await screen.findByTestId("erro-cotacao")
    expect(alerta).toBeInTheDocument()
    expect(alerta.textContent).toContain("FONTE_INDISPONIVEL")
    // Tela segue funcional: resultado vazio e formulário presente.
    expect(screen.getByTestId("valor-final")).toHaveTextContent("—")
    expect(screen.getByLabelText(/Taxa manual/i)).toBeInTheDocument()
  })

  it("NENHUMA chamada de escrita: só GETs na plataforma e na fonte", async () => {
    const { chamadas } = mockFetchSgs(CDI_DIA_0035)
    render(<CalculadoraScreen />)
    await selecionarIndice("CDI")
    await userEvent.click(screen.getByRole("button", { name: /Aportes mensais/i }))
    await userEvent.type(await screen.findByLabelText(/Taxa manual/i), "12")
    await userEvent.click(screen.getByRole("button", { name: /Depósito único/i }))

    await waitFor(() => expect(chamadas.length).toBeGreaterThanOrEqual(1))
    expect(chamadasHttp.length).toBeGreaterThanOrEqual(1)
    for (const chamada of chamadasHttp) {
      expect(chamada.method).toBe("GET")
    }
    for (const chamada of chamadas) {
      expect(chamada.method ?? "GET").toBe("GET")
    }
  })

  it("valida entrada inválida sem quebrar (prazo/valor/taxa)", async () => {
    render(<CalculadoraScreen />)
    const prazo = await screen.findByLabelText(/Prazo \(anos\)/i)
    await userEvent.clear(prazo)
    await userEvent.type(prazo, "0")
    expect(await screen.findByText(/inteiro ≥ 1/i)).toBeInTheDocument()
    expect(screen.getByTestId("valor-final")).toHaveTextContent("—")

    await userEvent.clear(prazo)
    await userEvent.type(prazo, "2")
    const taxa = screen.getByLabelText(/Taxa manual/i)
    await userEvent.type(taxa, "-5")
    expect(await screen.findByText(/taxa ≥ 0/i)).toBeInTheDocument()
  })
})
