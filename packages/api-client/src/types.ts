/**
 * Contratos do transporte HTTP (PoC §6.1 — packages/api-client).
 * O escopo vem do token: nenhum body carrega projetoId.
 */

/** Guarda os tokens da sessão (memória/localStorage — apps/web decide). */
export interface TokenStore {
  getAccessToken(): string | null
  getRefreshToken(): string | null
  setAccessToken(token: string | null): void
  setRefreshToken(token: string | null): void
}

/**
 * Chamado quando uma rota autenticada recebe 401: a aplicação tenta
 * renovar a sessão (refresh + select-project) e devolve true se conseguiu
 * (a chamada original é repetida UMA vez) ou false para assumir o 401.
 */
export type SessionRecovery = () => Promise<boolean>

/** Assinatura mínima de fetch — aceita o fetch nativo ou fakes de teste. */
export type FetchFn = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
  },
) => Promise<{ status: number; json(): Promise<unknown> }>

export interface ApiClientOptions {
  /** ex.: "http://localhost:3001/api" */
  baseUrl: string
  tokens: TokenStore
  fetchImpl?: FetchFn
}

export interface RealtimeClientOptions {
  url: string
  taskId: number
  lastSequence?: number
  onMessage(message: import("@biblioteca-global/shared").RealtimeServerMessage): void
  onError?(error: Event): void
  onStatusChange?(status: "connecting" | "open" | "closed"): void
  webSocketFactory?: (url: string) => WebSocket
}
