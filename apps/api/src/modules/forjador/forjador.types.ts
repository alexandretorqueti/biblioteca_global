import type { ForjarPersonaRequest } from "@biblioteca-global/shared"

export interface ForjadorSession {
  sessionKey: string
  sessionId?: string
  existing: boolean
}

export interface ForjadorBridge {
  resolveSession(input: { agentId: string; sessionKey: string; label: string }): Promise<ForjadorSession>
  send(input: { sessionKey: string; agentId: string; text: string }): Promise<void>
  describe(input: { sessionKey: string; agentId: string }): Promise<{ status?: string; state?: string; hasActiveRun?: boolean }>
  history(input: { sessionKey: string; maxChars?: number }): Promise<Array<{ role: "agent" | "user" | "system"; text?: string | null }>>
}

export interface ForjadorPersonaTexts {
  soul: string
  identity: string
  agents: string
}

export interface ForjadorServiceInput extends ForjarPersonaRequest {
  correlationId: string
}
