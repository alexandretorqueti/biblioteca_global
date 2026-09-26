/**
 * isa-chat.bridge.ts — Ponte HTTP com o BFF do openclaw-console.
 *
 * ÚNICO módulo que conhece o contrato do BFF (rotas, payloads, formatos).
 * Se o BFF mudar, apenas este arquivo é ajustado.
 *
 * Configuração via ConfigService (ISA_BFF_UPSTREAM, ISA_BFF_TOKEN).
 */
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { request as httpRequest, type RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"
import type {
  IsaChatBridge,
  IsaChatBridgeConfig,
  ResolvedSession,
  BridgeSendResult,
} from "./isa-chat.types"

const DEFAULT_TIMEOUT = 10_000

function bffFetch(
  config: IsaChatBridgeConfig,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${config.baseUrl.replace(/\/$/, "")}${path}`)
    const isHttps = url.protocol === "https:"
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: init.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT,
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

function emailSlug(email: string): string {
  const clean = email.trim().toLowerCase().replace(/[^a-z0-9]/g, "-")
  return clean.replace(/-+/g, "-").replace(/^-|-$/g, "") || "contato"
}

function canonicalAgentId(sessionKey: string): string | undefined {
  if (!sessionKey.startsWith("agent:")) return undefined
  return sessionKey.split(":")[1] || undefined
}

@Injectable()
export class IsaChatBridgeService implements IsaChatBridge {
  private readonly logger = new Logger(IsaChatBridgeService.name)
  private readonly config: IsaChatBridgeConfig

  constructor(private readonly configService: ConfigService) {
    this.config = {
      baseUrl: this.configService.get<string>("ISA_BFF_UPSTREAM") || "",
      token: this.configService.get<string>("ISA_BFF_TOKEN"),
      timeoutMs: Number(this.configService.get<string>("ISA_BFF_TIMEOUT_MS")) || DEFAULT_TIMEOUT,
    }
  }

  /** Verifica se a ponte está configurada. */
  isConfigured(): boolean {
    return Boolean(this.config.baseUrl)
  }

  async resolveSession(input: { agentId: string; chatKey: string }): Promise<ResolvedSession> {
    const slug = emailSlug(input.chatKey)
    const key = `agent:${input.agentId}:${slug}`
    const label = input.chatKey.trim().toLowerCase()

    try {
      const res = await bffFetch(this.config, "/api/sessions", {
        method: "POST",
        body: { key, agentId: input.agentId, label },
      })

      if (res.ok) {
        const data = (await res.json()) as {
          key?: string
          sessionId?: string
          existing?: boolean
        }
        if (data.existing) {
          await this.patchSessionLabel(key, input.agentId, label)
        }
        return {
          sessionKey: data.key ?? key,
          ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
          existing: Boolean(data.existing),
        }
      }
      return { sessionKey: key, existing: false }
    } catch (err) {
      this.logger.warn(`resolveSession failed: ${err}`)
      return { sessionKey: key, existing: false }
    }
  }

  async send(input: {
    sessionKey: string
    text: string
    attachments?: ReadonlyArray<{ name: string; size?: string }>
  }): Promise<BridgeSendResult> {
    const agentId = canonicalAgentId(input.sessionKey)
    try {
      this.logger.log(`Enviando mensagem para sessionKey=${input.sessionKey}, agentId=${agentId}`)
      const res = await bffFetch(this.config, "/api/chat/send", {
        method: "POST",
        body: {
          sessionKey: input.sessionKey,
          message: input.text,
          ...(agentId ? { agentId } : {}),
        },
      })

      this.logger.log(`Resposta do BFF: status=${res.status}, ok=${res.ok}`)

      if (res.ok) {
        const data = (await res.json()) as { runId?: string; messageId?: string }
        const id =
          typeof data.runId === "string"
            ? data.runId
            : typeof data.messageId === "string"
              ? data.messageId
              : undefined
        return {
          ok: true,
          ...(id !== undefined ? { messageId: id } : {}),
          retryable: false,
        }
      }
      const errorData = await res.json()
      this.logger.error(`BFF retornou erro: status=${res.status}, data=${JSON.stringify(errorData)}`)
      return { ok: false, retryable: res.status >= 500 }
    } catch (err) {
      this.logger.error(`send failed: ${err}`)
      return { ok: false, retryable: true }
    }
  }

  async abort(input: { sessionKey: string }): Promise<void> {
    const agentId = canonicalAgentId(input.sessionKey)
    try {
      await bffFetch(this.config, "/api/chat/abort", {
        method: "POST",
        body: { sessionKey: input.sessionKey, ...(agentId ? { agentId } : {}) },
      })
    } catch {
      /* abort é best-effort */
    }
  }

  async history(input: {
    sessionKey: string
    limit?: number
    offset?: number
  }): Promise<Array<{ role: "agent" | "user" | "system"; text?: string | null }>> {
    const query = new URLSearchParams({ sessionKey: input.sessionKey })
    if (input.limit != null) query.set("limit", String(input.limit))
    if (input.offset != null) query.set("offset", String(input.offset))

    try {
      const res = await bffFetch(this.config, `/api/chat/history?${query.toString()}`, {
        method: "GET",
      })

      if (res.ok) {
        const data = (await res.json()) as
          | { messages?: Array<{ role?: string; content?: string | null; text?: string | null }> }
          | Array<{ role?: string; content?: string | null; text?: string | null }>
        const arr = Array.isArray(data) ? data : (data.messages ?? [])
        const mapped: Array<{ role: "agent" | "user" | "system"; text?: string | null }> = []
        for (const m of arr) {
          const text = m.content ?? m.text ?? null
          if (m.role === "assistant") mapped.push({ role: "agent", text })
          else if (m.role === "user") mapped.push({ role: "user", text })
          else if (m.role === "system") mapped.push({ role: "system", text })
        }
        return mapped
      }
      return []
    } catch (err) {
      this.logger.warn(`history failed: ${err}`)
      return []
    }
  }

  async renameSession(input: {
    sessionKey: string
    agentId: string
    label: string
  }): Promise<void> {
    await this.patchSessionLabel(input.sessionKey, input.agentId, input.label)
  }

  private async patchSessionLabel(
    key: string,
    agentId: string,
    label: string,
  ): Promise<void> {
    try {
      await bffFetch(this.config, "/api/sessions", {
        method: "PATCH",
        body: { key, agentId, label },
      })
    } catch {
      /* label é estético; falha não bloqueia */
    }
  }
}
