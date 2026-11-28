// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import type { VitrinePublicaConteudo } from "@biblioteca-global/shared"
import VitrinePublica, {
  dividirTitulo,
  formatarBRL,
  indexarTextos,
} from "../VitrinePublica"

const estado = vi.hoisted(() => ({
  requests: [] as Array<{ method: string; path: string }>,
  conteudo: null as unknown as VitrinePublicaConteudo,
  falhar: false,
}))

vi.mock("../../../../apps/web/src/hooks/useApi", () => ({
  useApi: () => ({
    http: {
      request: async (method: string, path: string) => {
        estado.requests.push({ method, path })
        if (estado.falhar) throw new Error("rede caiu")
        return estado.conteudo
      },
    },
  }),
}))

const CONTEUDO_COMPLETO: VitrinePublicaConteudo = {
  textos: [
    { chave: "hero_titulo", secao: "hero", conteudo: "Título único do hero" },
    { chave: "hero_subtitulo", secao: "hero", conteudo: "Subtítulo único do hero" },
    { chave: "hero_cta", secao: "hero", conteudo: "Falar com a ISA" },
    { chave: "dor_alpha", secao: "dores", conteudo: "Dor alfa: descrição da dor alfa" },
    { chave: "beneficio_beta", secao: "beneficios", conteudo: "Benefício beta sem marcador de título" },
    { chave: "como_funciona_passo_1", secao: "como_funciona", conteudo: "Passo um: enviar o conteúdo" },
    { chave: "cta_titulo", secao: "cta", conteudo: "Título do CTA final" },
    { chave: "cta_texto", secao: "cta", conteudo: "Texto do CTA final" },
    { chave: "contato_texto", secao: "contato", conteudo: "Texto de contato" },
    {
      chave: "whatsapp_link",
      secao: "contato",
      conteudo: "https://wa.me/5521900000000?text=Vim%20pela%20vitrine",
    },
  ],
  metricas: [{ valor: "24/7", rotulo: "Atendimento contínuo" }],
  faq: [{ pergunta: "Pergunta única do FAQ?", resposta: "Resposta única do FAQ." }],
  segmentos: [{ titulo: "Segmento único", descricao: "Descrição do segmento", icone: "🏥" }],
  planos: [
    {
      nome: "Plano Gama",
      tagline: "Tagline do plano gama",
      precoMensal: 597,
      precoSetup: 2500,
      beneficios: ["Benefício exclusivo do gama"],
      textoBotao: "Quero o Gama",
      maisPopular: true,
    },
  ],
}

function renderizarTela() {
  return render(
    <BibliotecaThemeProvider>
      <VitrinePublica />
    </BibliotecaThemeProvider>,
  )
}

beforeEach(() => {
  estado.requests.length = 0
  estado.conteudo = CONTEUDO_COMPLETO
  estado.falhar = false
})

describe("VitrinePublica", () => {
  it("renderiza as 9 seções com conteúdo vindo do endpoint", async () => {
    renderizarTela()
    expect(screen.getByTestId("vitrine-loading")).toBeInTheDocument()

    expect(await screen.findByText("Título único do hero")).toBeInTheDocument()
    expect(estado.requests).toContainEqual({ method: "GET", path: "/vitrine/conteudo" })

    expect(screen.getByTestId("secao-hero")).toBeInTheDocument()
    expect(screen.getByTestId("secao-metricas")).toBeInTheDocument()
    expect(screen.getByTestId("secao-dores")).toBeInTheDocument()
    expect(screen.getByTestId("secao-beneficios")).toBeInTheDocument()
    expect(screen.getByTestId("secao-como-funciona")).toBeInTheDocument()
    expect(screen.getByTestId("secao-segmentos")).toBeInTheDocument()
    expect(screen.getByTestId("secao-planos")).toBeInTheDocument()
    expect(screen.getByTestId("secao-faq")).toBeInTheDocument()
    expect(screen.getByTestId("secao-cta")).toBeInTheDocument()

    // Conteúdo específico por seção
    expect(screen.getByText("Subtítulo único do hero")).toBeInTheDocument()
    expect(screen.getByText("24/7")).toBeInTheDocument()
    expect(screen.getByText("Atendimento contínuo")).toBeInTheDocument()
    expect(screen.getByText("descrição da dor alfa")).toBeInTheDocument()
    expect(screen.getByText("Benefício beta sem marcador de título")).toBeInTheDocument()
    expect(screen.getByText("Segmento único")).toBeInTheDocument()
    expect(screen.getByText("Quero o Gama")).toBeInTheDocument()
    expect(screen.getByText("Título do CTA final")).toBeInTheDocument()
  })

  it("todos os botões de WhatsApp usam o whatsapp_link do conteúdo (zero número hardcoded)", async () => {
    renderizarTela()
    await screen.findByText("Título único do hero")

    const links = screen.getAllByRole("link", { name: /WhatsApp|Gama|ISA/ })
    expect(links.length).toBeGreaterThanOrEqual(3) // hero + plano + CTA final
    for (const link of links) {
      expect(link).toHaveAttribute("href", CONTEUDO_COMPLETO.textos[9]!.conteudo)
      expect(link).toHaveAttribute("target", "_blank")
    }
  })

  it("sem whatsapp_link no conteúdo, nenhum botão de WhatsApp é renderizado", async () => {
    estado.conteudo = {
      ...CONTEUDO_COMPLETO,
      textos: CONTEUDO_COMPLETO.textos.filter((t) => t.chave !== "whatsapp_link"),
    }
    renderizarTela()
    await screen.findByText("Título único do hero")
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("omite seções cujas listas vêm vazias", async () => {
    estado.conteudo = {
      ...CONTEUDO_COMPLETO,
      metricas: [],
      faq: [],
      segmentos: [],
      planos: [],
      textos: CONTEUDO_COMPLETO.textos.filter(
        (t) => t.secao === "hero" || t.secao === "contato",
      ),
    }
    renderizarTela()
    await screen.findByText("Título único do hero")

    expect(screen.getByTestId("secao-hero")).toBeInTheDocument()
    expect(screen.getByTestId("secao-cta")).toBeInTheDocument()
    expect(screen.queryByTestId("secao-metricas")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-dores")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-beneficios")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-como-funciona")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-segmentos")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-planos")).not.toBeInTheDocument()
    expect(screen.queryByTestId("secao-faq")).not.toBeInTheDocument()
  })

  it("mostra estado vazio honesto quando não há conteúdo publicado", async () => {
    estado.conteudo = { textos: [], planos: [], metricas: [], faq: [], segmentos: [] }
    renderizarTela()
    expect(await screen.findByTestId("vitrine-vazio")).toBeInTheDocument()
    expect(screen.queryByTestId("secao-hero")).not.toBeInTheDocument()
  })

  it("mostra estado de erro quando a requisição falha", async () => {
    estado.falhar = true
    renderizarTela()
    expect(await screen.findByTestId("vitrine-erro")).toBeInTheDocument()
    expect(screen.queryByTestId("secao-planos")).not.toBeInTheDocument()
  })

  it("expande o FAQ no accordion", async () => {
    renderizarTela()
    await screen.findByText("Título único do hero")
    await userEvent.click(screen.getByText("Pergunta única do FAQ?"))
    await waitFor(() =>
      expect(screen.getByText("Resposta única do FAQ.")).toBeInTheDocument(),
    )
  })

  it("exibe preço em BRL pt-BR e tagline/destaque do plano", async () => {
    renderizarTela()
    await screen.findByText("Título único do hero")
    expect(screen.getByText("R$ 597")).toBeInTheDocument()
    expect(screen.getByText("Setup único: R$ 2.500")).toBeInTheDocument()
    expect(screen.getByText("Tagline do plano gama")).toBeInTheDocument()
    expect(screen.getByText("Mais popular")).toBeInTheDocument()
    expect(screen.getByText("Benefício exclusivo do gama")).toBeInTheDocument()
  })

  it("numera os passos de como-funciona na ordem da API", async () => {
    estado.conteudo = {
      ...CONTEUDO_COMPLETO,
      textos: [
        ...CONTEUDO_COMPLETO.textos,
        { chave: "como_funciona_passo_2", secao: "como_funciona", conteudo: "Passo dois: aprovar" },
      ],
    }
    renderizarTela()
    const secao = await screen.findByTestId("secao-como-funciona")
    expect(secao).toHaveTextContent("Passo um")
    expect(secao).toHaveTextContent("Passo dois")
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })
})

describe("helpers de VitrinePublica", () => {
  it("formatarBRL formata inteiros sem centavos e decimais com 2 casas", () => {
    // Intl usa NBSP (\u00a0) entre o símbolo e o valor
    expect(formatarBRL(297)).toBe("R$\u00a0297")
    expect(formatarBRL(1200)).toBe("R$\u00a01.200")
    expect(formatarBRL(297.5)).toBe("R$\u00a0297,50")
  })

  it("dividirTitulo separa 'Título: corpo' e mantém texto puro como corpo", () => {
    expect(dividirTitulo("Você nos manda o conteúdo: FAQs e catálogo")).toEqual({
      titulo: "Você nos manda o conteúdo",
      corpo: "FAQs e catálogo",
    })
    expect(dividirTitulo("Frase simples sem dois-pontos")).toEqual({
      titulo: null,
      corpo: "Frase simples sem dois-pontos",
    })
    expect(dividirTitulo(": começando com dois-pontos")).toEqual({
      titulo: null,
      corpo: ": começando com dois-pontos",
    })
  })

  it("indexarTextos mapeia chave→conteúdo (última ocorrência vence)", () => {
    const indice = indexarTextos([
      { chave: "a", secao: "hero", conteudo: "um" },
      { chave: "b", secao: "cta", conteudo: "dois" },
    ])
    expect(indice.get("a")).toBe("um")
    expect(indice.get("b")).toBe("dois")
    expect(indice.get("c")).toBeUndefined()
  })
})
