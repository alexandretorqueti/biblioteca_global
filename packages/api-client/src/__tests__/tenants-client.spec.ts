import { describe, expect, it, vi } from "vitest"
import type { TenantChatConfig } from "@biblioteca-global/shared"
import { ApiClientError } from "../errors"
import { TenantsChatClient } from "../tenants"

const config: TenantChatConfig = {
  nome: "Tenant de teste",
  persona: {},
  paleta: { primaria: "#112233", secundaria: "#223344", fundo: "#F8FAFC" },
  textos: { saudacao: "Olá", placeholder: "Digite", indisponivel: "Indisponível" },
  ferramentas: [],
  idiomas: ["pt-BR"],
  anexos: { permitido: false, tipos: [], maxMb: 10 },
  chat: { mostrarIndicadorDigitacao: true },
  lgpd: { aviso: "Aviso" },
  tema: { modo: "claro" },
  canais: { web: true, whatsapp: false },
}

describe("TenantsChatClient", () => {
  it("consulta o endpoint público por slug/domínio e retorna config tipado", async () => {
    const request = vi.fn().mockResolvedValue(config)
    const client = new TenantsChatClient({ request } as never)

    await expect(client.getChatConfig("alpha.example.com:8443")).resolves.toEqual({
      status: "ok",
      config,
    })
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/tenants/alpha.example.com%3A8443/chat-config",
      { auth: "none" },
    )
  })

  it("discrimina tenant suspenso e não encontrado", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new ApiClientError(403, "HTTP_403", "Erro", { status: "suspenso" }))
      .mockRejectedValueOnce(new ApiClientError(404, "HTTP_404", "Erro"))
    const client = new TenantsChatClient({ request } as never)

    await expect(client.getChatConfig("suspenso")).resolves.toEqual({ status: "suspenso" })
    await expect(client.getChatConfig("desconhecido")).resolves.toEqual({ status: "nao_encontrado" })
  })
})
