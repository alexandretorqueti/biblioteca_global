// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import type { VitrinePublicaConteudo } from "@biblioteca-global/shared"
import PedidoCompra, {
  revisarArquivos,
  telefoneParaEnvio,
} from "../PedidoCompra"

const TOKEN = "0123456789abcdef".repeat(4)

const CONTEUDO: VitrinePublicaConteudo = {
  textos: [],
  metricas: [],
  faq: [],
  segmentos: [],
  planos: [
    {
      nome: "Plano Gama",
      tagline: "Site + WhatsApp",
      precoMensal: 597,
      precoSetup: null,
      beneficios: [],
      textoBotao: null,
      maisPopular: false,
    },
    {
      nome: "Plano Alfa",
      tagline: null,
      precoMensal: 297,
      precoSetup: null,
      beneficios: [],
      textoBotao: null,
      maisPopular: false,
    },
  ],
}

const estado = vi.hoisted(() => ({
  conteudo: null as unknown as VitrinePublicaConteudo,
  falharConteudo: false,
  formularios: [] as FormData[],
  respostaPedido: null as unknown,
  erroPedido: null as { status: number; code: string; message: string } | null,
}))

vi.mock("../../../../apps/web/src/hooks/useApi", () => {
  let bundle: {
    http: { request: (method: string, path: string, opts?: { body?: unknown }) => Promise<unknown> }
  } | null = null
  const request = async (
    method: string,
    path: string,
    opts?: { body?: unknown },
  ): Promise<unknown> => {
    if (method === "GET" && path === "/vitrine/conteudo") {
      if (estado.falharConteudo) throw new Error("rede caiu")
      return estado.conteudo
    }
    if (method === "POST" && path === "/vitrine/pedidos") {
      estado.formularios.push(opts!.body as FormData)
      if (estado.erroPedido) {
        const { ApiClientError } = await import("@biblioteca-global/api-client")
        throw new ApiClientError(
          estado.erroPedido.status,
          estado.erroPedido.code,
          estado.erroPedido.message,
        )
      }
      return estado.respostaPedido
    }
    throw new Error(`rota não esperada: ${method} ${path}`)
  }
  return {
    // Bundle estável como no app real (contexto memoizado do AuthContext).
    useApi: () => (bundle ??= { http: { request } }),
  }
})

function renderizarFormulario(entry = "/vitrine-ia/pedido") {
  return render(
    <BibliotecaThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <PedidoCompra />
      </MemoryRouter>
    </BibliotecaThemeProvider>,
  )
}

async function preencherCamposObrigatorios(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Nome do negócio/), "Padaria do Bairro")
  await user.type(screen.getByLabelText(/Nome do contato/), "Ana Souza")
  await user.type(screen.getByLabelText(/^E-mail/), "ana@padaria.test")
  await user.type(screen.getByLabelText(/Telefone/), "11999998888")
  const combobox = await screen.findByRole("combobox", { name: /Plano/i })
  // O combo só abre quando os planos ativos terminam de carregar do conteúdo.
  await waitFor(() => expect(combobox).toBeEnabled())
  await user.click(combobox)
  await user.click(await screen.findByRole("option", { name: "Plano Gama" }))
}

beforeEach(() => {
  estado.conteudo = CONTEUDO
  estado.falharConteudo = false
  estado.formularios.length = 0
  estado.respostaPedido = {
    tokenAcompanhamento: TOKEN,
    status: "criado",
    criadoEm: "2026-11-28T12:00:00.000Z",
    mensagem: "Pedido recebido. Guarde o token de acompanhamento.",
  }
  estado.erroPedido = null
})

describe("PedidoCompra", () => {
  it("carrega planos do conteúdo público e comunica formatos/limites de upload", async () => {
    renderizarFormulario()
    const input = await screen.findByTestId("arquivos-input")
    expect(input).toHaveAttribute("accept", ".pdf,.docx,.txt")
    expect(input).toHaveAttribute("multiple")
    expect(screen.getByTestId("limite-upload")).toHaveTextContent("PDF, DOCX ou TXT")
    expect(screen.getByTestId("limite-upload")).toHaveTextContent("10 MB")
    expect(screen.getByTestId("limite-upload")).toHaveTextContent("10 arquivos")

    await userEvent.click(screen.getByRole("combobox", { name: /Plano/i }))
    expect(await screen.findByRole("option", { name: "Plano Gama" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Plano Alfa" })).toBeInTheDocument()
  })

  it("aplica a máscara brasileira de telefone durante a digitação", async () => {
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    const campo = screen.getByTestId("campo-telefone")
    await userEvent.type(campo, "11999998888")
    expect(campo).toHaveValue("+55 (11) 99999-8888")
  })

  it("bloqueia o envio sem o consentimento LGPD marcado", async () => {
    const user = userEvent.setup()
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    await preencherCamposObrigatorios(user)

    const botao = screen.getByTestId("botao-enviar")
    expect(botao).toBeDisabled()
    expect(screen.getByTestId("aviso-consentimento")).toBeInTheDocument()
    await user.click(botao).catch(() => undefined)
    expect(estado.formularios).toHaveLength(0)

    await user.click(screen.getByTestId("checkbox-lgpd"))
    await waitFor(() => expect(botao).toBeEnabled())
  })

  it("envia multipart com dados, texto livre e telefone desmascarado; confirmação traz o link do token", async () => {
    const user = userEvent.setup()
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    await preencherCamposObrigatorios(user)
    await user.type(
      screen.getByLabelText(/Texto livre/),
      "Vendemos pães artesanais desde 1998.",
    )
    fireEvent.change(screen.getByTestId("arquivos-input"), {
      target: { files: [new File(["%PDF-1.4"], "faq.pdf", { type: "application/pdf" })] },
    })
    await user.click(screen.getByTestId("checkbox-lgpd"))
    await user.click(screen.getByTestId("botao-enviar"))

    expect(await screen.findByTestId("confirmacao-sucesso")).toBeInTheDocument()
    expect(estado.formularios).toHaveLength(1)
    const form = estado.formularios[0]!
    const dados = JSON.parse(String(form.get("dados")))
    expect(dados).toMatchObject({
      nomeNegocio: "Padaria do Bairro",
      nomeContato: "Ana Souza",
      email: "ana@padaria.test",
      telefone: "(11) 99999-8888",
      plano: "Plano Gama",
      ciclo: "mensal",
      consentimentoLgpd: true,
    })
    expect(form.get("textoLivre")).toBe("Vendemos pães artesanais desde 1998.")
    expect(form.getAll("arquivos")).toHaveLength(1)

    // Mensagem de confirmação vem do backend (fonte única), não da UI.
    expect(screen.getByTestId("confirmacao-mensagem")).toHaveTextContent(
      "Guarde o token de acompanhamento.",
    )
    expect(screen.getByTestId("token-acompanhamento")).toHaveTextContent(TOKEN)
    expect(screen.getByTestId("link-acompanhar")).toHaveAttribute(
      "href",
      `/vitrine-ia/pedido/${TOKEN}`,
    )
  })

  it("rejeita arquivo fora da whitelist antes do envio, com mensagem clara", async () => {
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    fireEvent.change(screen.getByTestId("arquivos-input"), {
      target: { files: [new File([""], "virus.exe", { type: "application/x-msdownload" })] },
    })
    expect(await screen.findByTestId("arquivo-rejeicoes")).toHaveTextContent(
      "tipo não aceito",
    )
    expect(screen.queryByTestId("lista-arquivos")).not.toBeInTheDocument()
  })

  it("rejeita arquivo acima do limite informado na UI", async () => {
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    const grande = new File([new Uint8Array(11 * 1024 * 1024)], "pesado.pdf", {
      type: "application/pdf",
    })
    fireEvent.change(screen.getByTestId("arquivos-input"), {
      target: { files: [grande] },
    })
    expect(await screen.findByTestId("arquivo-rejeicoes")).toHaveTextContent("11 MB")
    expect(screen.queryByTestId("lista-arquivos")).not.toBeInTheDocument()
  })

  it("exibe a mensagem clara do 400 do backend como erro global", async () => {
    estado.erroPedido = {
      status: 400,
      code: "VALIDATION_ERROR",
      message: 'Dados do pedido inválidos — email: E-mail inválido',
    }
    const user = userEvent.setup()
    renderizarFormulario()
    await screen.findByTestId("arquivos-input")
    await preencherCamposObrigatorios(user)
    await user.click(screen.getByTestId("checkbox-lgpd"))
    await user.click(screen.getByTestId("botao-enviar"))

    expect(await screen.findByTestId("erro-global")).toHaveTextContent(
      "Dados do pedido inválidos — email: E-mail inválido",
    )
    expect(screen.queryByTestId("confirmacao-sucesso")).not.toBeInTheDocument()
  })

  it("pré-seleciona o plano vindo da query da vitrine (?plano=)", async () => {
    renderizarFormulario(`/vitrine-ia/pedido?plano=${encodeURIComponent("Plano Alfa")}`)
    await screen.findByTestId("arquivos-input")
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /Plano/i })).toHaveTextContent(
        "Plano Alfa",
      ),
    )
  })

  it("mostra erro honesto quando o conteúdo de planos falha", async () => {
    estado.falharConteudo = true
    renderizarFormulario()
    expect(await screen.findByText(/Não foi possível carregar os planos/)).toBeInTheDocument()
    expect(screen.getByTestId("botao-enviar")).toBeDisabled()
  })
})

describe("helpers de PedidoCompra", () => {
  it("telefoneParaEnvio remove o prefixo +55 mantendo DDD e número", () => {
    expect(telefoneParaEnvio("+55 (11) 99999-8888")).toBe("(11) 99999-8888")
    expect(telefoneParaEnvio("(21) 3333-4444")).toBe("(21) 3333-4444")
    expect(telefoneParaEnvio("+55")).toBe("")
  })

  it("revisarArquivos aceita whitelist, rejeita extensão proibida, vazio, oversized e excesso", () => {
    const ok = new File(["x"], "a.pdf", { type: "application/pdf" })
    const txtOk = new File(["oi"], "notas.txt", { type: "text/plain" })
    const exe = new File(["x"], "b.exe", { type: "application/x-msdownload" })
    const vazio = new File([""], "vazio.txt", { type: "text/plain" })
    const grande = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "g.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })

    const primeiro = revisarArquivos([], [ok, txtOk, exe, vazio, grande])
    expect(primeiro.aceitos.map((f) => f.name)).toEqual(["a.pdf", "notas.txt"])
    expect(primeiro.rejeicoes).toHaveLength(3)
    expect(primeiro.rejeicoes[0]).toContain("tipo não aceito")
    expect(primeiro.rejeicoes[1]).toContain("vazio")
    expect(primeiro.rejeicoes[2]).toContain("limite")

    const muitos = Array.from({ length: 12 }, (_, i) =>
      new File(["x"], `f${i}.txt`, { type: "text/plain" }),
    )
    const resultado = revisarArquivos([], muitos)
    expect(resultado.aceitos).toHaveLength(10)
    expect(resultado.estourouLimite).toBe(true)
    expect(resultado.rejeicoes.some((m) => m.includes("Máximo de 10 arquivos"))).toBe(true)
  })
})
