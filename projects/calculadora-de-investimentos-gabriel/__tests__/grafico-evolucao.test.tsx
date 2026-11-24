// @vitest-environment jsdom
/**
 * Testes do gráfico da evolução (plano macro #6, posição 5/9 — REQ-F-007/RF-7).
 *
 * Cobre o componente `GraficoEvolucao` (renderização SVG, eixo Y em BRL,
 * tooltip por ponto) e a integração na `CalculadoraScreen`: toggle
 * ano a ano / mês a mês trocando APENAS a série exibida — a projeção
 * continua memoizada (nenhum recálculo ao alternar; o motor intocado).
 *
 * Transporte mockado no mesmo padrão de calculadora-screen.test.tsx:
 * `useApi()`/`useAuth` falsos; sem rede.
 */
import "@testing-library/jest-dom/vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import CalculadoraScreen, {
  formatarBRL,
  serieDoGrafico,
} from "../screens/CalculadoraScreen"
import GraficoEvolucao, {
  calcularGeometria,
  rotuloDoPeriodo,
} from "../screens/GraficoEvolucao"
import { calcularProjecao, type PontoSerie } from "../calculo/projecao"

const { fakeRequest, apiFake } = vi.hoisted(() => {
  const fakeRequest = vi.fn()
  // Objeto estável: useApi re-render não revalida o cliente memoizado da
  // tela (o que re-dispararia o GET de índices em cada render).
  return { fakeRequest, apiFake: { http: { request: fakeRequest } } }
})

vi.mock("../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => apiFake,
}))

vi.mock("../../../apps/web/src/auth/AuthContext", () => ({
  useAuth: () => ({ projeto: { slug: "calculadora-de-investimentos-gabriel" } }),
}))

/** Ver (U+00A0) → espaço: o matcher jest-dom normaliza o texto do elemento. */
function normalizar(texto: string): string {
  return texto.replace(/\u00a0/g, " ")
}

function brlEsperado(valor: number): string {
  return normalizar(formatarBRL(valor))
}

/** Mesmo formato do eixo Y do gráfico: BRL sem centavos (Intl pt-BR). */
const FORMATADOR_TICK = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
})

function tickEsperado(valor: number): string {
  return normalizar(FORMATADOR_TICK.format(valor))
}

/** CRUD GET de índices vazio (a tela usa taxa manual nos testes). */
beforeEach(() => {
  fakeRequest.mockReset()
  fakeRequest.mockImplementation(async (method: unknown, path: unknown) => {
    if (method === "GET" && String(path).endsWith("/indices")) {
      return { items: [], total: 0, page: 1, pageSize: 100 }
    }
    throw new Error(`chamada HTTP inesperada: ${String(method)} ${String(path)}`)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Série sintética para o teste do componente puro. */
function seriePura(quantidade: number, passo = 100): PontoSerie[] {
  return Array.from({ length: quantidade }, (_, i) => ({
    mes: i + 1,
    valor: (i + 1) * passo,
    valorInvestido: (i + 1) * passo,
  }))
}

describe("GraficoEvolucao — utilidades puras", () => {
  it("rótulos de período: Mês k (mensal) e Ano k (anual, mês 12·ano)", () => {
    expect(rotuloDoPeriodo("mensal", 1)).toBe("Mês 1")
    expect(rotuloDoPeriodo("mensal", 13)).toBe("Mês 13")
    expect(rotuloDoPeriodo("anual", 12)).toBe("Ano 1")
    expect(rotuloDoPeriodo("anual", 24)).toBe("Ano 2")
  })

  it("geometria: null sem pontos; base em 0; máximo da série no topo", () => {
    expect(calcularGeometria([])).toBeNull()
    const geo = calcularGeometria(seriePura(3, 100))
    expect(geo).not.toBeNull()
    if (!geo) return
    expect(geo.y(0)).toBeGreaterThan(geo.y(300))
    expect(geo.caminhoLinha.startsWith("M")).toBe(true)
    expect(geo.ticks[0]).toBe(0)
    expect(geo.ticks[geo.ticks.length - 1]).toBe(300)
  })

  it("serieDoGrafico colhe a série memoizada sem recalcular", () => {
    const projecao = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 2,
      taxaMensalPercentual: 1,
    })
    expect(serieDoGrafico(projecao, "anual")).toBe(projecao.pontosAnuais)
    expect(serieDoGrafico(projecao, "mensal")).toBe(projecao.pontosMensais)
    expect(serieDoGrafico(null, "anual")).toBeNull()
  })
})

describe("GraficoEvolucao — renderização SVG", () => {
  it("renderiza linha/área, pontos e eixo Y em BRL", () => {
    const pontos = seriePura(12)
    const { container } = render(
      <GraficoEvolucao pontos={pontos} periodo="mensal" formatarValor={formatarBRL} />,
    )
    const svg = container.querySelector("svg")
    expect(svg).toBeInTheDocument()
    expect(svg?.getAttribute("viewBox")).toBeTruthy()
    expect(svg?.getAttribute("width")).toBe("100%")
    // linha + área
    const paths = container.querySelectorAll("path")
    expect(paths.length).toBe(2)
    // um <circle> por ponto da série
    expect(screen.getAllByTestId("ponto-grafico")).toHaveLength(12)
    // eixo Y: ticks em BRL (Intl pt-BR) presentes no DOM
    const textos = [...container.querySelectorAll("text")].map((t) =>
      normalizar(t.textContent ?? ""),
    )
    expect(textos.some((t) => /^R\$/.test(t))).toBe(true)
    expect(textos.some((t) => t === tickEsperado(300))).toBe(true)
    expect(textos.some((t) => t === tickEsperado(0))).toBe(true)
  })

  it("tooltip por ponto: título SVG com período + valor em BRL", () => {
    const pontos = seriePura(12, 250)
    render(
      <GraficoEvolucao pontos={pontos} periodo="mensal" formatarValor={formatarBRL} />,
    )
    const circulos = screen.getAllByTestId("ponto-grafico")
    const tituloUltimo = circulos[11]?.querySelector("title")?.textContent ?? ""
    expect(normalizar(tituloUltimo)).toContain("Mês 12")
    expect(normalizar(tituloUltimo)).toContain(brlEsperado(3000))
  })

  it("nada renderiza sem pontos", () => {
    const { container } = render(
      <GraficoEvolucao pontos={[]} periodo="anual" />,
    )
    expect(container.querySelector("svg")).not.toBeInTheDocument()
  })
})

describe("CalculadoraScreen — gráfico com toggle ano a ano / mês a mês", () => {
  /** Renderiza a tela com taxa manual 12% a.a. e prazo 2 anos. */
  async function telaComProjecao(): Promise<ReturnType<typeof render>> {
    const utils = render(<CalculadoraScreen />)
    const taxaInput = await screen.findByLabelText(/Taxa manual/i)
    await userEvent.type(taxaInput, "12")
    const prazo = screen.getByLabelText(/Prazo \(anos\)/i)
    await userEvent.clear(prazo)
    await userEvent.type(prazo, "2")
    await screen.findByTestId("painel-grafico")
    return utils
  }

  it("exibe o gráfico abaixo do valor final, coerente com o valorFinal", async () => {
    await telaComProjecao()
    const esperado = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 2,
      taxaAnualPercentual: 12,
    })
    const painel = screen.getByTestId("painel-grafico")
    const grafico = within(painel).getByTestId("grafico-evolucao")
    expect(grafico).toBeInTheDocument()

    // Coerência: o ÚLTIMO ponto de cada série termina no valorFinal exibido.
    const ultimoAnual = esperado.pontosAnuais[esperado.pontosAnuais.length - 1]
    const ultimoMensal = esperado.pontosMensais[esperado.pontosMensais.length - 1]
    expect(ultimoAnual?.valor).toBeCloseTo(esperado.valorFinal, 6)
    expect(ultimoMensal?.valor).toBeCloseTo(esperado.valorFinal, 6)
    expect(screen.getByTestId("valor-final")).toHaveTextContent(
      brlEsperado(esperado.valorFinal),
    )

    // Visão inicial anual: prazoAnos pontos; tooltip do último ponto = Ano 2 + BRL.
    const pontosAnuais = within(painel).getAllByTestId("ponto-grafico")
    expect(pontosAnuais).toHaveLength(2)
    const titulo = pontosAnuais[1]?.querySelector("title")?.textContent ?? ""
    expect(normalizar(titulo)).toContain("Ano 2")
    expect(normalizar(titulo)).toContain(brlEsperado(esperado.valorFinal))
  })

  it("toggle troca a série sem recalcular (12·prazo ↔ prazo)", async () => {
    const esperado = calcularProjecao({
      modo: "unico",
      valorInicial: 1000,
      prazoAnos: 2,
      taxaAnualPercentual: 12,
    })
    const painel = await telaComProjecao().then(() => screen.getByTestId("painel-grafico"))

    expect(within(painel).getAllByTestId("ponto-grafico")).toHaveLength(2)

    await userEvent.click(screen.getByRole("button", { name: /Mês a mês/i }))
    expect(within(painel).getAllByTestId("ponto-grafico")).toHaveLength(24)
    expect(
      within(painel).getByText(/visão mês a mês · 24 pontos/),
    ).toBeInTheDocument()
    // Valor final segue o mesmo (nenhum recálculo alterou a projeção).
    expect(screen.getByTestId("valor-final")).toHaveTextContent(
      brlEsperado(esperado.valorFinal),
    )

    await userEvent.click(screen.getByRole("button", { name: /Ano a ano/i }))
    expect(within(painel).getAllByTestId("ponto-grafico")).toHaveLength(2)
    expect(
      within(painel).getByText(/visão ano a ano · 2 pontos/),
    ).toBeInTheDocument()
  })

  it("alternar não dispara HTTP: toggle é estado local de visão sobre a série memoizada", async () => {
    await telaComProjecao()
    const painel = screen.getByTestId("painel-grafico")
    const antes = fakeRequest.mock.calls.length

    await userEvent.click(screen.getByRole("button", { name: /Mês a mês/i }))
    await userEvent.click(screen.getByRole("button", { name: /Ano a ano/i }))

    // Nenhum chamado HTTP novo (toggle é 100% estado local de visão).
    expect(fakeRequest.mock.calls.length).toBe(antes)
    // Série mensal colhida do MESMO objeto memoizado tem 24 pontos.
    await userEvent.click(screen.getByRole("button", { name: /Mês a mês/i }))
    expect(within(painel).getAllByTestId("ponto-grafico")).toHaveLength(24)
  })

  it("SVG é responsivo: viewBox + width 100%, sem overflow do painel", async () => {
    await telaComProjecao()
    const svg = screen
      .getByTestId("painel-grafico")
      .querySelector("svg") as SVGSVGElement | null
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/)
    expect(svg?.getAttribute("width")).toBe("100%")
    expect(svg?.getAttribute("style") ?? "").toContain("display: block")
  })
})
