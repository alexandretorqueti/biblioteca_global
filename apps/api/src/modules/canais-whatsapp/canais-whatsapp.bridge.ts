import { Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { request as httpRequest, type RequestOptions } from "node:http"
import { request as httpsRequest } from "node:https"
import {
  whatsappGatewayStatusResponseSchema,
  whatsappLoginStartResponseSchema,
  whatsappLoginWaitResponseSchema,
  whatsappProvisionRequestSchema,
  whatsappDeleteResponseSchema,
  type WhatsappGatewayStatusResponse,
  type WhatsappLoginStartResponse,
  type WhatsappLoginWaitResponse,
} from "@biblioteca-global/shared"
import type { CanaisWhatsappBridge } from "./canais-whatsapp.types"

const DEFAULT_TIMEOUT_MS = 10_000
type BridgeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

function requestConsole(baseUrl: string, token: string, path: string, init: { method: string; body?: unknown }): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    let url: URL
    try { url = new URL(`${baseUrl.replace(/\/$/, "")}${path}`) } catch (error) { reject(new Error(`Console upstream inválido: ${error instanceof Error ? error.message : String(error)}`)); return }
    const secure = url.protocol === "https:"
    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method: init.method,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: { accept: "application/json", "content-type": "application/json", ...(init.body !== undefined ? { "content-length": Buffer.byteLength(JSON.stringify(init.body)) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
    req.on("timeout", () => req.destroy(new Error("Console request timed out")))
    if (init.body !== undefined) req.write(JSON.stringify(init.body))
    req.end()
  })
}

function consoleError(status: number, path: string): Error { return new Error(`Console HTTP ${status}: ${path}`) }

@Injectable()
export class CanaisWhatsappBridgeService implements CanaisWhatsappBridge {
  private readonly baseUrl: string
  private readonly token: string

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>("CANAIS_BFF_UPSTREAM") || config.get<string>("ISA_BFF_UPSTREAM") || ""
    this.token = config.get<string>("CANAIS_BFF_TOKEN") || config.get<string>("ISA_BFF_TOKEN") || ""
  }

  async loginStart(accountId: string): Promise<WhatsappLoginStartResponse> {
    const path = "/api/whatsapp/login/start"
    const response = await requestConsole(this.baseUrl, this.token, path, { method: "POST", body: { accountId } })
    if (!response.ok) throw consoleError(response.status, path)
    return whatsappLoginStartResponseSchema.parse(await response.json())
  }

  async loginWait(accountId: string): Promise<WhatsappLoginWaitResponse> {
    const path = "/api/whatsapp/login/wait"
    const response = await requestConsole(this.baseUrl, this.token, path, { method: "POST", body: { accountId } })
    if (!response.ok) throw consoleError(response.status, path)
    return whatsappLoginWaitResponseSchema.parse(await response.json())
  }

  async status(): Promise<WhatsappGatewayStatusResponse> {
    const path = "/api/whatsapp/status"
    const response = await requestConsole(this.baseUrl, this.token, path, { method: "GET" })
    if (!response.ok) throw consoleError(response.status, path)
    return whatsappGatewayStatusResponseSchema.parse(await response.json())
  }

  async provision(input: { accountId: string; agentId: string; displayName: string }): Promise<void> {
    const path = "/api/whatsapp/provision"
    const body = { accountId: input.accountId, agentId: input.agentId, displayName: input.displayName }
    whatsappProvisionRequestSchema.parse({ agentId: input.agentId, displayName: input.displayName })
    const response = await requestConsole(this.baseUrl, this.token, path, { method: "POST", body })
    if (!response.ok) throw consoleError(response.status, path)
  }

  async remove(accountId: string): Promise<void> {
    const path = "/api/whatsapp/login"
    const response = await requestConsole(this.baseUrl, this.token, path, { method: "DELETE", body: { accountId } })
    if (!response.ok) throw consoleError(response.status, path)
    whatsappDeleteResponseSchema.parse(await response.json())
  }
}
