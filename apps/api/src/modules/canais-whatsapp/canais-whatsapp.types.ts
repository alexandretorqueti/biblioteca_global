import type {
  WhatsappGatewayStatusResponse,
  WhatsappLoginStartResponse,
  WhatsappLoginWaitResponse,
} from "@biblioteca-global/shared"

export type CanalWhatsappEstado = "pareando" | "ativo" | "expirado" | "removido"

export interface CanalWhatsappRow {
  id: number
  tenantId: number
  tenantSlug: string
  tenantNome: string
  accountId: string
  numero: string | null
  agentId: string | null
  estado: CanalWhatsappEstado
  ultimoStatusEm: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CanaisWhatsappBridge {
  loginStart(accountId: string): Promise<WhatsappLoginStartResponse>
  loginWait(accountId: string): Promise<WhatsappLoginWaitResponse>
  status(): Promise<WhatsappGatewayStatusResponse>
  provision(input: { accountId: string; agentId: string; displayName: string }): Promise<void>
  remove(accountId: string): Promise<void>
}

export const CANAIS_WHATSAPP_BRIDGE = Symbol("CANAIS_WHATSAPP_BRIDGE")

export interface CanalWhatsappResolverResult {
  status: "encontrado" | "desconhecido"
  tenantId?: number
  slug?: string
  agentId?: string
  sessionKey?: string
}
