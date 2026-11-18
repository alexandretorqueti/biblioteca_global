import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { request as httpRequest, type RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"
import type { ForjadorBridge, ForjadorSession } from "./forjador.types"

const REQUEST_TIMEOUT_MS = 10_000
type BffResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

function requestBff(baseUrl: string, token: string, path: string, init: { method: string; body?: unknown } = { method: "GET" }): Promise<BffResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`)
    const secure = url.protocol === "https:"
    const options: RequestOptions = {
      hostname: url.hostname, port: url.port || (secure ? 443 : 80), path: url.pathname + url.search,
      method: init.method, timeout: REQUEST_TIMEOUT_MS,
      headers: { accept: "application/json", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }
    const req = (secure ? httpsRequest : httpRequest)(options, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => { body += chunk })
      res.on("end", () => resolve({
        ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
        status: res.statusCode ?? 0,
        json: async () => { try { return JSON.parse(body) as unknown } catch { return {} } },
      }))
    })
    req.on("error", reject)
    req.on("timeout", () => { req.destroy(new Error("Gateway request timed out")) })
    if (init.body !== undefined) req.write(JSON.stringify(init.body))
    req.end()
  })
}

function errorFor(status: number, path: string): Error {
  return new Error(`Console HTTP ${status}: ${path}`)
}

@Injectable()
export class ForjadorBridgeService implements ForjadorBridge {
  private readonly logger = new Logger(ForjadorBridgeService.name)
  private readonly baseUrl: string
  private readonly token: string

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>("FORJADOR_BFF_UPSTREAM") || config.get<string>("ISA_BFF_UPSTREAM") || ""
    this.token = config.get<string>("FORJADOR_BFF_TOKEN") || config.get<string>("ISA_BFF_TOKEN") || ""
  }

  async resolveSession(input: { agentId: string; sessionKey: string; label: string }): Promise<ForjadorSession> {
    const response = await requestBff(this.baseUrl, this.token, "/api/sessions", { method: "POST", body: { key: input.sessionKey, agentId: input.agentId, label: input.label } })
    if (!response.ok) throw errorFor(response.status, "/api/sessions")
    const data = await response.json() as { key?: string; sessionId?: string; existing?: boolean }
    return { sessionKey: data.key ?? input.sessionKey, ...(data.sessionId ? { sessionId: data.sessionId } : {}), existing: Boolean(data.existing) }
  }

  async send(input: { sessionKey: string; agentId: string; text: string }): Promise<void> {
    const response = await requestBff(this.baseUrl, this.token, "/api/chat/send", { method: "POST", body: { sessionKey: input.sessionKey, agentId: input.agentId, message: input.text } })
    if (!response.ok) throw errorFor(response.status, "/api/chat/send")
  }

  async describe(input: { sessionKey: string; agentId: string }): Promise<{ status?: string; state?: string; hasActiveRun?: boolean }> {
    const query = new URLSearchParams({ key: input.sessionKey, agentId: input.agentId })
    const response = await requestBff(this.baseUrl, this.token, `/api/sessions/describe?${query.toString()}`)
    if (!response.ok) throw errorFor(response.status, "/api/sessions/describe")
    return await response.json() as { status?: string; state?: string; hasActiveRun?: boolean }
  }

  async history(input: { sessionKey: string; maxChars?: number }): Promise<Array<{ role: "agent" | "user" | "system"; text?: string | null }>> {
    const query = new URLSearchParams({ sessionKey: input.sessionKey, maxChars: String(input.maxChars ?? 200_000) })
    const response = await requestBff(this.baseUrl, this.token, `/api/chat/history?${query.toString()}`)
    if (!response.ok) throw errorFor(response.status, "/api/chat/history")
    const data = await response.json() as { messages?: Array<{ role?: string; content?: string | null; text?: string | null }> } | Array<{ role?: string; content?: string | null; text?: string | null }>
    const messages = Array.isArray(data) ? data : data.messages ?? []
    return messages.flatMap((message) => {
      const role = message.role === "assistant" ? "agent" : message.role
      return role === "agent" || role === "user" || role === "system" ? [{ role, text: message.content ?? message.text ?? null }] : []
    })
  }
}
