/**
 * Cliente de API externa — faz chamadas a back-ends arbitrários.
 *
 * Diferença para ApiHttpClient: não injeta token de sessão automaticamente.
 * Usa um token externo fornecido explicitamente ou auth "none".
 * Suporta pathTemplate com interpolação de parênteses (:id → valor).
 */
import { ApiClientError } from "./errors"
import type { FetchFn } from "./types"

/** Erro padronizado de cliente externo. */
export class ExternalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "ExternalApiError"
  }

  static fromResponse(status: number, body: unknown): ExternalApiError {
    if (body && typeof body === "object" && "code" in body) {
      const erro = body as {
        code: string
        message?: string
        details?: unknown
      }
      return new ExternalApiError(
        status,
        erro.code,
        erro.message ?? "Erro",
        erro.details,
      )
    }
    // Mapeamento genérico de códigos HTTP comuns.
    const mapa: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      422: "UNPROCESSABLE_ENTITY",
      429: "TOO_MANY_REQUESTS",
      500: "INTERNAL_SERVER_ERROR",
      502: "BAD_GATEWAY",
      503: "SERVICE_UNAVAILABLE",
    }
    return new ExternalApiError(status, mapa[status] ?? `HTTP_${status}`, "Erro externo")
  }
}

export interface ExternalApiClientOptions {
  baseUrl: string
  /** TokenBearer opcional — se omitido, auth fica "none". */
  bearerToken?: string
  fetchImpl?: FetchFn
}

interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
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

/**
 * Interpola placeholders ":nome" no pathTemplate com os valores de params.
 * Se um par required for faltando, lança erro claro.
 */
function interpolarPath(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/:(\w+)/g, (_match, chave: string) => {
    if (!(chave in params)) {
      throw new Error(`parâmetro obrigatório "${chave}" ausente em ${template}`)
    }
    return String(params[chave as keyof typeof params])
  })
}

export class ExternalApiClient<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly fetchImpl: FetchFn

  constructor(private readonly options: ExternalApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) =>
      fetch(url, init).then((r) => ({
        status: r.status,
        json: () => r.json() as Promise<unknown>,
      }))
    )
  }

  /** GET externo com retorno tipado. */
  get(pathTemplate: string, params?: Record<string, string | number>, opts?: RequestOptions): Promise<T> {
    return this.executar<T>("GET", pathTemplate, params, opts)
  }

  /** POST externo com retorno tipado. */
  post<P = unknown>(pathTemplate: string, params: Record<string, string | number>, body: P, opts?: RequestOptions): Promise<T> {
    return this.executar<T>("POST", pathTemplate, params, { ...opts, body })
  }

  /** PUT externo com retorno tipado. */
  put<P = unknown>(pathTemplate: string, params: Record<string, string | number>, body: P, opts?: RequestOptions): Promise<T> {
    return this.executar<T>("PUT", pathTemplate, params, { ...opts, body })
  }

  /** DELETE externo com retorno tipado. */
  delete(pathTemplate: string, params?: Record<string, string | number>, opts?: RequestOptions): Promise<T> {
    return this.executar<T>("DELETE", pathTemplate, params, opts)
  }

  private async executar<X = T>(
    method: string,
    pathTemplate: string,
    params: Record<string, string | number> | undefined,
    opts: RequestOptions = {},
  ): Promise<X> {
    const interpolated = params ? interpolarPath(pathTemplate, params) : pathTemplate
    const headers: Record<string, string> = {}

    if (this.options.bearerToken) {
      headers.Authorization = `Bearer ${this.options.bearerToken}`
    }
    if (opts.headers) {
      for (const [chave, valor] of Object.entries(opts.headers)) {
        headers[chave] = valor
      }
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json"
    }

    const url = `${this.options.baseUrl}${interpolated}${montarQuery(opts.query)}`
    const resposta = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    const dados: unknown = await resposta.json().catch(() => undefined)

    if (resposta.status >= 200 && resposta.status < 300) {
      return dados as X
    }
    throw ExternalApiError.fromResponse(resposta.status, dados)
  }
}
