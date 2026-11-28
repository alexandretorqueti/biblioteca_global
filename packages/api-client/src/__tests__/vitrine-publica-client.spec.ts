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
