// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BibliotecaThemeProvider } from "@biblioteca-global/ui"
import type { VitrinePedidoAcompanhamento } from "@biblioteca-global/shared"
import PedidoAcompanhamento, {
  formatarBytes,
  formatarDataHora,
} from "../PedidoAcompanhamento"

const TOKEN = "0123456789abcdef".repeat(4)

const estado = vi.hoisted(() => ({
  chamadas: [] as string[],
  erro: null as { status: number; code: string; message: string } | null,
  resposta: null as unknown,
}))

vi.mock("../../../../apps/web/src/hooks/useApi", () => {
  let bundle: { http: { request: (method: string, path: string) => Promise<unknown> } } | null =
    null
  const request = async (method: string, path: string): Promise<unknown> => {
    estado.chamadas.push(`${method} ${path}`)
    if (estado.erro) {
      const { ApiClientError } = await import("@biblioteca-global/api-client")
      throw new ApiClientError(estado.erro.status, estado.erro.code, estado.erro.message)
    }
    return estado.resposta
  }
  return {
    // Bundle estável como no app real (useApi devolve contexto memoizado) —
    // evita re-render em cascata/requisições duplicadas nos testes.
    useApi: () => (bundle ??= { http: { request } }),
  }
})

const PEDIDO: VitrinePedidoAcompanhamento = {
  nomeNegocio: "Padaria do Bairro",
  nomeContato: "Ana Souza",
  email: "ana@padaria.test",
  telefone: "(11) 99999-8888",
  informacoesNegocio: null,
  planoNome: "Plano Gama",
  ciclo: "mensal",
  status: "criado",
  criadoEm: "2026-11-28T12:00:00.000Z",
  documentos: [
    { nomeOriginal: "faq.pdf", tipoConteudo: "pdf", tamanhoBytes: 1234 },
    { nomeOriginal: null, tipoConteudo: "texto_livre", tamanhoBytes: 42 },
  ],
}

function renderizar(token = TOKEN) {
  return render(
    <BibliotecaThemeProvider>
      <MemoryRouter initialEntries={[`/vitrine-ia/pedido/${token}`]}>
        <Routes>
          <Route path="/vitrine-ia/pedido/:token" element={<PedidoAcompanhamento />} />
        </Routes>
      </MemoryRouter>
    </BibliotecaThemeProvider>,
  )
}

beforeEach(() => {
  estado.chamadas.length = 0
  estado.erro = null
  estado.resposta = PEDIDO
})

describe("PedidoAcompanhamento", () => {
  it("carrega pelo token e exibe status, plano e documentos do próprio pedido", async () => {
    renderizar()
    expect(screen.getByTestId("acompanhamento-loading")).toBeInTheDocument()

    expect(await screen.findByTestId("chip-status")).toHaveTextContent("Pedido recebido")
    expect(estado.chamadas).toEqual(["GET /vitrine/pedidos/" + TOKEN])
    expect(screen.getByText("Padaria do Bairro")).toBeInTheDocument()
    expect(screen.getByText(/Plano Gama/)).toBeInTheDocument()
    expect(screen.getByText(/28 de novembro de 2026/)).toBeInTheDocument()

    const lista = screen.getByTestId("lista-documentos")
    expect(lista).toHaveTextContent("faq.pdf")
    expect(lista).toHaveTextContent("1,2 KB")
    expect(lista).toHaveTextContent("Texto livre enviado no formulário")
    expect(lista).toHaveTextContent("42 B")
  })

  it("404 vira mensagem clara de link inválido, sem dado inventado", async () => {
    estado.erro = { status: 404, code: "NOT_FOUND", message: "Pedido não encontrado." }
    renderizar(TOKEN)
    expect(await screen.findByTestId("acompanhamento-invalido")).toBeInTheDocument()
    expect(screen.queryByTestId("chip-status")).not.toBeInTheDocument()
  })

  it("falha de rede tem estado de erro honesto com nova tentativa", async () => {
    estado.erro = { status: 500, code: "INTERNAL_ERROR", message: "Erro" }
    renderizar()
    expect(await screen.findByTestId("acompanhamento-erro")).toBeInTheDocument()

    estado.erro = null
    await userEvent.click(screen.getByTestId("botao-tentar-de-novo"))
    expect(await screen.findByTestId("chip-status")).toHaveTextContent("Pedido recebido")
    expect(estado.chamadas).toHaveLength(2)
  })

  it("pedido sem documentos exibe aviso próprio e informações completas", async () => {
    estado.resposta = {
      ...PEDIDO,
      status: "aguardando_pagamento",
      informacoesNegocio: "Entregamos na região central.",
      documentos: [],
    }
    renderizar()
    expect(await screen.findByTestId("chip-status")).toHaveTextContent("Aguardando pagamento")
    expect(screen.queryByTestId("acompanhamento-erro")).toBeNull()
    expect(screen.getByTestId("documentos-vazio")).toBeInTheDocument()
    expect(screen.getByTestId("bloco-informacoes")).toHaveTextContent(
      "Entregamos na região central.",
    )
  })

  it("resposta fora do contrato vira estado de erro (nunca dado inventado)", async () => {
    estado.resposta = { ...PEDIDO, linkAgente: "https://agente.example" }
    renderizar()
    expect(await screen.findByTestId("acompanhamento-erro")).toBeInTheDocument()
  })
})

describe("helpers de PedidoAcompanhamento", () => {
  it("formatarDataHora traduz ISO pt-BR e preserva string inválida", () => {
    expect(formatarDataHora("2026-11-28T12:00:00.000Z")).toContain("28 de novembro de 2026")
    expect(formatarDataHora("não-é-data")).toBe("não-é-data")
  })

  it("formatarBytes cobre B/KB/MB e null sem inventar valor", () => {
    expect(formatarBytes(512)).toBe("512 B")
    expect(formatarBytes(1234)).toBe("1,2 KB")
    expect(formatarBytes(3 * 1024 * 1024)).toBe("3 MB")
    expect(formatarBytes(null)).toBe("—")
  })
})
