/**
 * Executor de ação customizada (PoC — sistema gerado).
 * Dispara POST/PUT/DELETE para rotas de ação definidas no JSON de config
 * do GeradorSistema. Retorno e erro são tipados contra o contrato API.
 */
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

/** Payload genérico enviado ao action (JSON serializável). */
export type ActionPayload = Record<string, unknown> | null

/** Retorno de uma ação customizada — o back define a estrutura real. */
export interface ActionResult<T = unknown> {
  /** Código de resultado da ação (ex.: "OK", "VALIDATION_ERROR"). */
  code: string
  /** Mensagem legível ao usuário. */
  message: string
  /** Dados específicos do domínio (se houver). */
  data?: T
  /** Detalhes de erro/validation (se houver). */
  details?: unknown
}

/**
 * Opções para disparar uma ação customizada.
 */
export interface ExecuteActionOptions {
  /** Payload enviado no corpo da requisição. */
  payload?: ActionPayload
  /** Headers adicionais (ex.: token de serviço). */
  headers?: Record<string, string>
  /** Query params adicionales. */
  query?: Record<string, string | number | boolean | undefined>
}

/**
 * Cliente para disparar ações customizadas definidas no sistema gerado.
 * Cada ação é uma rota REST arbitrária dentro do resource do projeto;
 * o cliente monta method/path e propaga erros tipados.
 */
export class ActionExecutor {
  constructor(
    private readonly http: ApiHttpClient,
    private readonly resource: string,
  ) {}

  /**
   * Dispara um POST na ação customizada.
   * @param action — nome da ação (ex.: "execute", "aprovar", "exportar")
   * @returns resultado tipado da ação
   */
  post(action: string, payload?: ActionPayload, opts?: ExecuteActionOptions): Promise<ActionResult> {
    return this.dispachar("POST", action, payload, opts)
  }

  /**
   * Dispara um PUT na ação customizada.
   */
  put(action: string, payload?: ActionPayload, opts?: ExecuteActionOptions): Promise<ActionResult> {
    return this.dispachar("PUT", action, payload, opts)
  }

  /**
   * Dispara um DELETE na ação customizada.
   */
  delete(action: string, payload?: ActionPayload, opts?: ExecuteActionOptions): Promise<ActionResult> {
    return this.dispachar("DELETE", action, payload, opts)
  }

  private async dispachar(
    method: "POST" | "PUT" | "DELETE",
    action: string,
    payload: ActionPayload | undefined,
    opts: ExecuteActionOptions | undefined,
  ): Promise<ActionResult> {
    const headers: Record<string, string> = {}
    if (payload !== null && payload !== undefined) {
      headers["Content-Type"] = "application/json"
    }
    if (opts?.headers) {
      for (const [chave, valor] of Object.entries(opts.headers)) {
        headers[chave] = valor
      }
    }

    const query: Record<string, string | number | boolean | undefined> = { ...opts?.query }

    const url = `/${this.resource}/${action}${montarQueryString(query)}`

    try {
      const resultado = await this.http.request<ActionResult>(method, url, {
        body: payload !== null && payload !== undefined ? payload : undefined,
        headers,
        auth: "access",
      })
      // Garante que o retorno segue o contrato ActionResult mesmo se o back enviar corpo direto.
      if (resultado && typeof resultado === "object" && "code" in resultado) {
        return resultado as ActionResult
      }
      // Se o back retornou payload simples, embutir em ActionResult genérico.
      return { code: "OK", message: "", data: resultado }
    } catch (erro) {
      if (erro instanceof ApiClientError) {
        throw erro
      }
      // Fallback: qualquer outro erro vira ApiClientError 500.
      throw new ApiClientError(
        500,
        "INTERNAL_ERROR",
        erro instanceof Error ? erro.message : "Erro desconhecido ao executar ação",
      )
    }
  }
}

function montarQueryString(
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
