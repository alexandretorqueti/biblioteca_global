/**
 * helpdesk-client.ts — Cliente HTTP do HelpDesk.
 *
 * Segue o padrão de agent-chat-client: transporte isolado, sem conhecimento
 * de rotas na UI. Endpoints `/helpdesk/*`, auth via cookie HttpOnly
 * `bg_access_token` (mesmo mecanismo do api-client).
 */
import {
  helpDeskHistorySchema,
  type HelpDeskHistory,
  type HelpDeskSendMessageInput,
} from "@biblioteca-global/shared"

import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

// ── Tipos públicos ─────────────────────────────────────────────────────

export interface HelpDeskSessionInfo {
  sessaoId: number
  agenteId: string
}

export interface HelpDeskSendResult {
  ok: boolean
  messageId?: string
  reason?: "offline" | "session_not_found" | "chat_closed" | "http_error"
  retryable?: boolean
}

export interface HelpDeskDriver {
  readonly sessaoId: number | null
  readonly agenteId: string
  obterSessao(): Promise<HelpDeskSessionInfo | null>
  criarSessao(usuarioId: number, projetoId: number): Promise<HelpDeskSessionInfo>
  enviarMensagem(input: HelpDeskSendMessageInput): Promise<HelpDeskSendResult>
  obterHistorico(sessaoId: number): Promise<HelpDeskHistory>
}

// ── Opções de configuração ─────────────────────────────────────────────

export interface HelpDeskClientOptions {
  http: ApiHttpClient
  /** Rota base; padrão `/helpdesk`. */
  basePath?: string
}

const DEFAULT_BASE_PATH = "/helpdesk"

// ── Factory ────────────────────────────────────────────────────────────

export function createHelpDeskClient(options: HelpDeskClientOptions): HelpDeskDriver {
  const base = options.basePath ?? DEFAULT_BASE_PATH
  let cachedSessao: HelpDeskSessionInfo | null = null

  async function obterSessao(): Promise<HelpDeskSessionInfo | null> {
    if (cachedSessao) return cachedSessao
    try {
      const data = await options.http.request<unknown>("POST", `${base}/session`, {
        body: {},
      })
      const result = data as { ok?: unknown; sessaoId?: unknown; agenteId?: unknown } | null
      if (!result || typeof result.sessaoId !== "number" || !result.agenteId) {
        return null
      }
      cachedSessao = {
        sessaoId: result.sessaoId,
        agenteId: String(result.agenteId),
      }
      return cachedSessao
    } catch (error) {
      // Se o backend não tem HelpDesk ainda, retorna null silenciosamente.
      if (error instanceof ApiClientError && error.status === 404) return null
      throw error
    }
  }

  async function criarSessao(): Promise<HelpDeskSessionInfo> {
    const data = await options.http.request<unknown>("POST", `${base}/session`, {
      body: {},
    })
    const result = data as { ok?: unknown; sessaoId?: unknown; agenteId?: unknown } | null
    if (!result || typeof result.sessaoId !== "number" || !result.agenteId) {
      throw new ApiClientError(502, "INVALID_HELPDESK_RESPONSE", "Sessão HelpDesk não retornou dados válidos")
    }
    cachedSessao = { sessaoId: result.sessaoId, agenteId: String(result.agenteId) }
    return cachedSessao
  }

  async function enviarMensagem(input: HelpDeskSendMessageInput): Promise<HelpDeskSendResult> {
    try {
      const data = await options.http.request<unknown>("POST", `${base}/send`, {
        body: input,
      })
      const result = data as Record<string, unknown> | null
      if (result && typeof result.ok === "boolean" && !result.ok) {
        const reason = result.reason as HelpDeskSendResult["reason"] | undefined
        return {
          ok: false,
          reason: reason ?? "http_error",
          retryable: result.retryable === true,
        }
      }
      return {
        ok: true,
        messageId: typeof result?.messageId === "string" ? result.messageId : undefined,
      }
    } catch (error) {
      if (error instanceof ApiClientError) {
        const status = error.status
        // 404 = HelpDesk desativado; offline permanente.
        if (status === 404) return { ok: false, reason: "offline", retryable: false }
        // 5xx = erro transitório.
        if (status >= 500) return { ok: false, reason: "http_error", retryable: true }
        return { ok: false, reason: "session_not_found" }
      }
      return { ok: false, reason: "offline", retryable: true }
    }
  }

  async function obterHistorico(sessaoId: number): Promise<HelpDeskHistory> {
    const data = await options.http.request<unknown>("GET", `${base}/${sessaoId}/history`)
    const result = data as { sessao?: unknown; mensagens?: unknown } | null
    if (!result || !result.sessao) {
      return {
        sessao: {
          id: sessaoId,
          usuarioId: 0,
          projetoId: 0,
          agenteId: "",
          status: "closed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        mensagens: [],
      }
    }
    const parsed = helpDeskHistorySchema.safeParse(result)
    if (!parsed.success) {
      throw new ApiClientError(502, "INVALID_HELPDESK_HISTORY", "Histórico HelpDesk não segue o contrato", parsed.error)
    }
    return parsed.data
  }

  return {
    get sessaoId() { return cachedSessao?.sessaoId ?? null },
    get agenteId() { return cachedSessao?.agenteId ?? "" },
    obterSessao,
    criarSessao,
    enviarMensagem,
    obterHistorico,
  }
}
