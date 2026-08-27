/**
 * Cliente HTTP do apps/web — única porta para o back (regra do projeto:
 * a UI nunca fala HTTP direto; a camada de transporte é a api-client).
 *
 * A baseUrl usa a porta do Vite em dev (proxied para a API em /api). Em
 * produção o front é servido no mesmo host/prefixo da API ou a url vem do
 * build; para simplificar, resolvemos para "/api" relativo ao documento.
 */
import {
  ApiHttpClient,
  AuthClient,
} from "@biblioteca-global/api-client"

/** Base url resolvida: protocolo+host atuais + /api (proxy dev / deploy). */
export function resolveApiBaseUrl(): string {
  const configuredApiUrl = import.meta.env.VITE_API_URL
  if (configuredApiUrl) return configuredApiUrl
  if (typeof window !== "undefined") {
    const { protocol, host } = window.location
    return `${protocol}//${host}/api`
  }
  return "http://localhost:3001/api"
}

export function resolveRealtimeUrl(): string {
  const base = resolveApiBaseUrl().replace(/^http/, "ws")
  return `${base}/realtime/ws`
}

export interface ApiClientBundle {
  http: ApiHttpClient
  auth: AuthClient
}

/** Builda o bundle a partir de um TokenStore (o AuthContext fornece o store). */
export function createApiClient(tokens: {
  getAccessToken(): string | null
  getRefreshToken(): string | null
  setAccessToken(token: string | null): void
  setRefreshToken(token: string | null): void
}): ApiClientBundle {
  const http = new ApiHttpClient({
    baseUrl: resolveApiBaseUrl(),
    tokens,
  })
  return { http, auth: new AuthClient(http) }
}
