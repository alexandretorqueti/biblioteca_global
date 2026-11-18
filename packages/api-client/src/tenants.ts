/**
 * Client tipado de tenants (isas-mt-02): resolução do chat-config público
 * de um tenant pelo slug OU pelo domínio (host) cadastrado. A UI não faz
 * fetch cru — todo transporte passa por ApiHttpClient (PoC §3/§7.4).
 */
import type { TenantChatConfig } from "@biblioteca-global/shared"
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

/** Resposta 403 do backend quando o tenant está suspenso (body literal). */
export interface TenantSuspensoResult {
  status: "suspenso"
}

/** Tenant não cadastrado (slug/domínio desconhecido → HTTP 404). */
export interface TenantNaoEncontradoResult {
  status: "nao_encontrado"
}

/** Qualquer outra falha (rede, 5xx, sessão, tenant em onboarding): a UI decide como reportar. */
export interface TenantChatConfigErroResult {
  status: "erro"
  error: unknown
}

export type TenantChatConfigResult =
  | { status: "ok"; config: TenantChatConfig }
  | TenantSuspensoResult
  | TenantNaoEncontradoResult
  | TenantChatConfigErroResult

export interface TenantChatConfigOptions {
  signal?: AbortSignal
}

export class TenantsChatClient {
  constructor(private readonly http: ApiHttpClient) {}

  /**
   * GET /api/tenants/:slug/chat-config — o parâmetro aceita slug ou domínio
   * (resolução por Host no backend). Nunca lança nos estados de domínio
   * (suspenso/não encontrado); devolve discriminação tipada.
   */
  async getChatConfig(
    slugOrHost: string,
    options: TenantChatConfigOptions = {},
  ): Promise<TenantChatConfigResult> {
    try {
      const config = await this.http.request<TenantChatConfig>(
        "GET",
        `/tenants/${encodeURIComponent(slugOrHost)}/chat-config`,
        { auth: "none", ...(options.signal ? { signal: options.signal } : {}) },
      )
      return { status: "ok", config }
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        return { status: "nao_encontrado" }
      }
      if (error instanceof ApiClientError && error.status === 403 && isTenantSuspenso(error.details)) {
        return { status: "suspenso" }
      }
      return { status: "erro", error }
    }
  }
}

function isTenantSuspenso(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { status?: unknown }).status === "suspenso"
  )
}

export function createTenantsChatClient(http: ApiHttpClient): TenantsChatClient {
  return new TenantsChatClient(http)
}
