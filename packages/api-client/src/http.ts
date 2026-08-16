/**
 * Núcleo do transporte HTTP: injeção automática de token, erro padronizado
 * e recuperação de sessão em 401 (PoC §5.3/§7.4).
 * Regra de ouro: projetoId JAMAIS sai do cliente — o escopo vem do token.
 */
import { ApiClientError } from "./errors"
import type {
  ApiClientOptions,
  FetchFn,
  SessionRecovery,
} from "./types"

export type AuthMode = "access" | "refresh" | "none"

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  auth?: AuthMode
  /** Headers adicionais (ex.: Authorization com token de serviço). */
  headers?: Record<string, string>
}

/** Defesa em profundidade: nenhum body pode carregar projetoId. */
export function assertSemProjetoId(body: unknown): void {
  if (
    body &&
    typeof body === "object" &&
    "projetoId" in (body as Record<string, unknown>)
  ) {
    throw new Error(
      "projetoId jamais deve ser enviado pelo cliente — o escopo vem do token",
    )
  }
}

function montarQuery(
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return ""
  const partes: string[] = []
  for (const [chave, valor] of Object.entries(query)) {
    if (valor === undefined) continue
    partes.push(`${encodeURIComponent(chave)}=${encodeURIComponent(String(valor))}`)
  }
  return partes.length > 0 ? `?${partes.join("&")}` : ""
}

export class ApiHttpClient {
  private recovery: SessionRecovery | undefined
  private readonly fetchImpl: FetchFn

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) =>
      fetch(url, init).then((r) => ({
        status: r.status,
        json: () => r.json() as Promise<unknown>,
      }))
    )
  }

  /** Registra a estratégia de renovação de sessão (apps/web, Etapa 9). */
  setSessionRecovery(recovery: SessionRecovery): void {
    this.recovery = recovery
  }

  request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    return this.executar<T>(method, path, opts, true)
  }

  private async executar<T>(
    method: string,
    path: string,
    opts: RequestOptions,
    podeRecuperar: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {}
    const auth: AuthMode = opts.auth ?? "access"
    // Regra de ouro: com token de acesso (operações no escopo do projeto),
    // projetoId jamais sai do cliente. Única exceção legítima: o fluxo de
    // seleção de projeto (PoC §5.1), que usa o refresh token.
    if (opts.body !== undefined && auth === "access") {
      assertSemProjetoId(opts.body)
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json"
    }
    if (opts.headers) {
      for (const [chave, valor] of Object.entries(opts.headers)) {
        headers[chave] = valor
      }
    }
    if (auth === "access") {
      const token = this.options.tokens.getAccessToken()
      if (token) headers.Authorization = `Bearer ${token}`
    } else if (auth === "refresh") {
      const token = this.options.tokens.getRefreshToken()
      if (token) headers.Authorization = `Bearer ${token}`
    }

    const url = `${this.options.baseUrl}${path}${montarQuery(opts.query)}`
    const resposta = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (
      resposta.status === 401 &&
      auth === "access" &&
      podeRecuperar &&
      this.recovery
    ) {
      const recuperou = await this.recovery()
      if (recuperou) {
        return this.executar<T>(method, path, opts, false)
      }
    }

    const dados: unknown = await resposta.json().catch(() => undefined)
    if (resposta.status >= 200 && resposta.status < 300) {
      return dados as T
    }
    throw ApiClientError.fromResponse(resposta.status, dados)
  }
}
