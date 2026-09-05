/**
 * helpdesk.bridge.ts — Ponte HTTP com o BFF do openclaw-console.
 *
 * Segue o padrão isa-chat.bridge.ts: comunicação HTTP pura com o BFF,
 * usando OPENCLAW_CONSOLE_URL + token via ConfigService.
 */
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { request as httpRequest, type RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"

const DEFAULT_TIMEOUT = 10_000

function bffFetch(
  baseUrl: string,
  token: string | undefined,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`)
    const isHttps = url.protocol === "https:"
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: init.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      timeout: DEFAULT_TIMEOUT,
    }

    const req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
      let data = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => (data += chunk))
      res.on("end", () => {
        resolve({
          ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
          json: () => {
            try {
              return Promise.resolve(JSON.parse(data))
            } catch {
              return Promise.resolve({})
            }
          },
        })
      })
    })

    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("timeout"))
    })

    if (init.body) {
      req.write(JSON.stringify(init.body))
    }
    req.end()
  })
}

export interface BridgeSendResult {
  ok: boolean
  messageId?: string
  retryable?: boolean
}

/** Resolved session from BFF /api/sessions POST. */
interface BffSessionResult {
  key?: string
  sessionId?: string
  existing?: boolean
}

@Injectable()
export class HelpDeskBridgeService {
  private readonly logger = new Logger(HelpDeskBridgeService.name)
  private readonly baseUrl: string
  private readonly token: string | undefined

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>("OPENCLAW_CONSOLE_URL") || ""
    this.token = this.configService.get<string>("OPENCLAW_CONSOLE_TOKEN")
  }

  /** Verifica se a ponte está configurada. */
  isConfigured(): boolean {
    return Boolean(this.baseUrl)
  }

  /**
   * Resolve ou cria uma sessão no BFF para o agente informado.
   * Chave: `agent:{agenteId}:{chatKey}` onde chatKey = projetoId_hash.
   */
  async resolveSession(input: {
    agenteId: string
    usuarioId: number
    projetoId: number
  }): Promise<{ sessionKey: string; existing: boolean }> {
    const chatKey = `${input.projetoId}_${input.usuarioId}`
    const key = `agent:${input.agenteId}:${chatKey}`

    try {
      const res = await bffFetch(this.baseUrl, this.token, "/api/sessions", {
        method: "POST",
        body: {
          key,
          agentId: input.agenteId,
          label: `helpdesk:${input.projetoId}:${input.usuarioId}`,
        },
      })

      if (res.ok) {
        const data = await res.json() as BffSessionResult
        return {
          sessionKey: data.key ?? key,
          existing: Boolean(data.existing),
        }
      }
      this.logger.warn(`resolveSession fallback: status=${res.status}`)
      return { sessionKey: key, existing: false }
    } catch (err) {
      this.logger.warn(`resolveSession failed: ${err}`)
      return { sessionKey: key, existing: false }
    }
  }

  /**
   * Envia mensagem ao agente via BFF. Implementa fallback em cadeia:
   * tenta cada modelo da cadeia; se falhar, tenta o próximo.
   */
  async sendWithChain(input: {
    sessionKey: string
    text: string
    modelChain: Array<{ modelo: string }>
  }): Promise<BridgeSendResult> {
    for (const entry of input.modelChain) {
      try {
        this.logger.log(
          `Tentando agente ${entry.modelo} para sessionKey=${input.sessionKey}`,
        )

        const agentId = extractAgentId(input.sessionKey)
        const res = await bffFetch(this.baseUrl, this.token, "/api/chat/send", {
          method: "POST",
          body: {
            sessionKey: input.sessionKey,
            message: input.text,
            ...(agentId ? { agentId } : {}),
            model: entry.modelo,
          },
        })

        if (res.ok) {
          const data = await res.json() as Record<string, unknown>
          const id =
            typeof data.runId === "string"
              ? data.runId
              : typeof data.messageId === "string"
                ? data.messageId
                : undefined
          this.logger.log(`Resposta de ${entry.modelo}: ok=true`)
          return {
            ok: true,
            messageId: id,
            retryable: false,
          }
        }

        this.logger.warn(
          `${entry.modelo} retornou status=${res.status}, tentando próximo...`,
        )
      } catch (err) {
        this.logger.warn(`${entry.modelo} falhou (${err}), tentando próximo...`)
      }
    }

    this.logger.error(`Todos os modelos da cadeia falharam para ${input.sessionKey}`)
    return { ok: false, retryable: false }
  }

  /** Busca histórico de mensagens via BFF. */
  async getHistory(input: {
    sessionKey: string
    limit?: number
    offset?: number
  }): Promise<Array<{ role: "agent" | "user" | "system"; text: string | null }>> {
    const query = new URLSearchParams({ sessionKey: input.sessionKey })
    if (input.limit != null) query.set("limit", String(input.limit))
    if (input.offset != null) query.set("offset", String(input.offset))

    try {
      const res = await bffFetch(this.baseUrl, this.token, `/api/chat/history?${query.toString()}`, {
        method: "GET",
      })

      if (res.ok) {
        const data = await res.json()
        const arr = Array.isArray(data) ? data : ((data as Record<string, unknown>).messages ?? []) as Array<Record<string, unknown>>
        const mapped: Array<{ role: "agent" | "user" | "system"; text: string | null }> = []
        for (const m of arr) {
          const text = m.content ?? m.text ?? ""
          let role: "agent" | "user" | "system" = "agent"
          if (m.role === "assistant") role = "agent"
          else if (m.role === "user") role = "user"
          else if (m.role === "system") role = "system"
          mapped.push({ role, text })
        }
        return mapped
      }
      this.logger.warn(`history failed: status=${res.status}`)
    } catch (err) {
      this.logger.warn(`history failed: ${err}`)
    }
    return []
  }

  /** Aborta uma sessão ativa no BFF. */
  async abort(input: { sessionKey: string }): Promise<void> {
    try {
      await bffFetch(this.baseUrl, this.token, "/api/chat/abort", {
        method: "POST",
        body: {
          sessionKey: input.sessionKey,
          agentId: extractAgentId(input.sessionKey),
        },
      })
    } catch {
      /* abort é best-effort */
    }
  }

  /** Renomeia a sessão no BFF. */
  async renameSession(input: {
    sessionKey: string
    agentId: string
    label: string
  }): Promise<void> {
    try {
      await bffFetch(this.baseUrl, this.token, "/api/sessions", {
        method: "PATCH",
        body: { key: input.sessionKey, agentId: input.agentId, label: input.label },
      })
    } catch {
      /* rename é estético */
    }
  }
}

function extractAgentId(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith("agent:")) return undefined
  return sessionKey.split(":")[1] || undefined
}
