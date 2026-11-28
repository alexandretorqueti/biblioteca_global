import { describe, expect, it, vi } from "vitest"
import type { VitrinePublicaConteudo } from "@biblioteca-global/shared"
import { ApiClientError } from "../errors"
import { VitrinePublicaClient, createVitrinePublicaClient } from "../vitrine-publica-client"

const conteudo: VitrinePublicaConteudo = {
  textos: [
    { chave: "hero_titulo", secao: "hero", conteudo: "Título da vitrine" },
    { chave: "whatsapp_link", secao: "contato", conteudo: "https://wa.me/5511900000000" },
  ],
  planos: [
    {
      nome: "Pro",
      tagline: "Site + WhatsApp",
      precoMensal: 597,
      precoSetup: 2500,
      beneficios: ["Conversas ilimitadas"],
      textoBotao: "Quero o Pro",
      maisPopular: true,
    },
  ],
  metricas: [{ valor: "24/7", rotulo: "Atendimento contínuo" }],
  faq: [{ pergunta: "Preciso trocar de número?", resposta: "Não." }],
  segmentos: [{ titulo: "Clínicas", descricao: "Agendamento", icone: "hospital" }],
}

describe("VitrinePublicaClient", () => {
  it("consulta o endpoint público sem token e retorna o contrato tipado", async () => {
    const request = vi.fn().mockResolvedValue(conteudo)
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.obterConteudo()).resolves.toEqual(conteudo)
    expect(request).toHaveBeenCalledWith("GET", "/vitrine/conteudo", { auth: "none" })
  })

  it("rejeita resposta com chave fora do contrato (strict)", async () => {
    const request = vi.fn().mockResolvedValue({ ...conteudo, pedidos: [] })
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.obterConteudo()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    })
  })

  it("rejeita resposta incompleta com erro de contrato", async () => {
    const request = vi.fn().mockResolvedValue({ textos: [] })
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.obterConteudo()).rejects.toBeInstanceOf(ApiClientError)
  })

  it("propaga falha HTTP do endpoint", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiClientError(503, "HTTP_503", "Erro"))
    const client = createVitrinePublicaClient({ request } as never)

    await expect(client.obterConteudo()).rejects.toMatchObject({ status: 503 })
  })
})

// ── Pedidos públicos (macro #10, posição 3/11 — subtarefa 2) ───────────────
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"

const dadosPedidoValidos = {
  nomeNegocio: "Padaria do Bairro",
  nomeContato: "Ana Souza",
  email: "ana@padaria.test",
  telefone: "(11) 99999-8888",
  plano: "Pro",
  ciclo: "mensal",
  consentimentoLgpd: true,
} as const

const respostaCriacaoValida = {
  tokenAcompanhamento: TOKEN,
  status: "criado" as const,
  criadoEm: "2026-11-28T12:00:00.000Z",
  mensagem: "Pedido recebido.",
}

const respostaAcompanhamentoValida = {
  nomeNegocio: "Padaria do Bairro",
  nomeContato: "Ana Souza",
  email: "ana@padaria.test",
  telefone: "(11) 99999-8888",
  informacoesNegocio: null,
  planoNome: "Pro",
  ciclo: "mensal" as const,
  status: "criado" as const,
  criadoEm: "2026-11-28T12:00:00.000Z",
  documentos: [
    { nomeOriginal: "faq.pdf", tipoConteudo: "pdf" as const, tamanhoBytes: 1234 },
    { nomeOriginal: null, tipoConteudo: "texto_livre" as const, tamanhoBytes: 42 },
  ],
}

describe("VitrinePublicaClient — criarPedido (multipart, auth none)", () => {
  it("monta FormData com dados JSON, arquivos e textoLivre e chama POST sem token", async () => {
    const request = vi.fn().mockResolvedValue(respostaCriacaoValida)
    const client = new VitrinePublicaClient({ request } as never)

    const pdf = new File(["%PDF-1.4"], "faq.pdf", { type: "application/pdf" })
    const txt = new File(["olá"], "carta.txt", { type: "text/plain" })
    const resposta = await client.criarPedido({
      dados: dadosPedidoValidos,
      arquivos: [pdf, txt],
      textoLivre: "Trabalhamos com pães artesanais desde 1998.",
    })

    expect(resposta).toEqual(respostaCriacaoValida)
    expect(request).toHaveBeenCalledTimes(1)
    const [method, path, opts] = request.mock.calls[0] as [
      string,
      string,
      { body: FormData; auth: string },
    ]
    expect(method).toBe("POST")
    expect(path).toBe("/vitrine/pedidos")
    expect(opts.auth).toBe("none")
    expect(opts.body).toBeInstanceOf(FormData)

    const form = opts.body
    expect(JSON.parse(String(form.get("dados")))).toEqual(dadosPedidoValidos)
    const arquivos = form.getAll("arquivos")
    expect(arquivos).toHaveLength(2)
    expect((arquivos[0] as File).name).toBe("faq.pdf")
    expect(form.get("textoLivre")).toBe("Trabalhamos com pães artesanais desde 1998.")
    // Nenhum campo de fluxo viaja do cliente — o contrato não os conhece.
    expect(form.get("status")).toBeNull()
    expect(form.get("planoId")).toBeNull()
  })

  it("omite textoLivre em branco e segue sem arquivos quando não enviados", async () => {
    const request = vi.fn().mockResolvedValue(respostaCriacaoValida)
    const client = new VitrinePublicaClient({ request } as never)

    await client.criarPedido({ dados: dadosPedidoValidos, textoLivre: "   " })

    const [, , opts] = request.mock.calls[0] as [string, string, { body: FormData }]
    expect(opts.body.get("textoLivre")).toBeNull()
    expect(opts.body.getAll("arquivos")).toHaveLength(0)
  })

  it("resposta fora do contrato (chave extra) vira ApiClientError explícito", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ...respostaCriacaoValida, id: 7, pagamentoId: null })
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.criarPedido({ dados: dadosPedidoValidos })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    })
  })

  it("token malformado na resposta é rejeitado pelo parse strict", async () => {
    const request = vi.fn().mockResolvedValue({
      ...respostaCriacaoValida,
      tokenAcompanhamento: "curto-demais",
    })
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.criarPedido({ dados: dadosPedidoValidos })).rejects.toBeInstanceOf(
      ApiClientError,
    )
  })

  it("propaga o 400 do backend (mensagem clara do service) sem reescrever", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          400,
          "VALIDATION_ERROR",
          'Dados do pedido inválidos — telefone: Telefone BR inválido: informe DDD e número',
        ),
      )
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.criarPedido({ dados: dadosPedidoValidos })).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("telefone"),
    })
  })
})

describe("VitrinePublicaClient — obterPedidoPorToken", () => {
  it("consulta GET /vitrine/pedidos/:token sem token de sessão", async () => {
    const request = vi.fn().mockResolvedValue(respostaAcompanhamentoValida)
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.obterPedidoPorToken(TOKEN)).resolves.toEqual(
      respostaAcompanhamentoValida,
    )
    expect(request).toHaveBeenCalledWith("GET", `/vitrine/pedidos/${TOKEN}`, {
      auth: "none",
    })
  })

  it("codifica o token no path (sem injeção de rota)", async () => {
    const request = vi.fn().mockResolvedValue(respostaAcompanhamentoValida)
    const client = new VitrinePublicaClient({ request } as never)

    await client.obterPedidoPorToken("a/b?c")

    expect(request).toHaveBeenCalledWith(
      "GET",
      `/vitrine/pedidos/${encodeURIComponent("a/b?c")}`,
      { auth: "none" },
    )
  })

  it("resposta com campo interno (caminhoArmazenamento) é rejeitada pelo strict", async () => {
    const request = vi.fn().mockResolvedValue({
      ...respostaAcompanhamentoValida,
      documentos: [
        { ...respostaAcompanhamentoValida.documentos[0], caminhoArmazenamento: "pedido/x/y" },
      ],
    })
    const client = new VitrinePublicaClient({ request } as never)

    await expect(client.obterPedidoPorToken(TOKEN)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    })
  })

  it("propaga 404 (link inválido) como ApiClientError", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "Pedido não encontrado."))
    const client = createVitrinePublicaClient({ request } as never)

    await expect(client.obterPedidoPorToken("0".repeat(64))).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })
  })
})
