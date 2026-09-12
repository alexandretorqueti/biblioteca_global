import {
  erroReportavel,
  montarEndpointCanonico,
  type ErrorReportOrigem,
  type ErrorReportUsuario,
} from "@biblioteca-global/shared"
import type { ApiHttpClient } from "./http"

export interface ErrorReportEntrada {
  method: string
  /** Caminho da chamada, sem a base da API. */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  status: number | null
  responseBody?: unknown
  erro?: unknown
}

export interface ErrorReportContext {
  usuario: ErrorReportUsuario
  origem: ErrorReportOrigem
  /** Slug do projeto ativo, quando disponível no front. */
  slug?: string
}

export interface CreateErrorReporterOptions {
  http: ApiHttpClient
  getContext(): ErrorReportContext
  /** Janela anti-spam por endpoint, em milissegundos. */
  janelaMs?: number
}

function serializarErro(erro: unknown): {
  name: string
  message: string
  code?: string
  details?: unknown
} | undefined {
  if (erro === undefined) return undefined
  if (erro instanceof Error) {
    const candidato = erro as Error & { code?: unknown; details?: unknown }
    return {
      name: erro.name || "Error",
      message: erro.message,
      ...(typeof candidato.code === "string" ? { code: candidato.code } : {}),
      ...(candidato.details !== undefined ? { details: candidato.details } : {}),
    }
  }
  return { name: "UnknownError", message: String(erro) }
}

/** Cria o reporter fire-and-forget usado pelo único transporte HTTP do front. */
export function createErrorReporter({
  http,
  getContext,
  janelaMs = 5_000,
}: CreateErrorReporterOptions): {
  relatar(entrada: ErrorReportEntrada): void
} {
  const endpointsRecentes = new Map<string, number>()

  return {
    relatar(entrada): void {
      let contexto: ErrorReportContext
      try {
        contexto = getContext()
        const erro = serializarErro(entrada.erro)
        const decisao = erroReportavel({
          status: entrada.status,
          code: erro?.code,
          origem: contexto.origem,
        })
        if (!decisao.reportavel) return

        const endpoint = montarEndpointCanonico({
          method: entrada.method,
          path: entrada.path,
          slug: contexto.slug,
        })
        const agora = Date.now()
        const ultimo = endpointsRecentes.get(endpoint)
        if (ultimo !== undefined && agora - ultimo < janelaMs) return
        endpointsRecentes.set(endpoint, agora)

        void http
          .request("POST", "/erros", {
            body: {
              endpoint,
              url: entrada.path.split(/[?#]/, 1)[0] ?? entrada.path,
              ...(entrada.query !== undefined ? { query: entrada.query } : {}),
              ...(entrada.body !== undefined ? { requestBody: entrada.body } : {}),
              responseStatus: entrada.status,
              ...(entrada.responseBody !== undefined
                ? { responseBody: entrada.responseBody }
                : {}),
              ...(erro !== undefined ? { error: erro } : {}),
              usuario: contexto.usuario,
              origem: contexto.origem,
              ocorridoEm: new Date().toISOString(),
            },
            skipErrorReporter: true,
          })
          .catch(() => undefined)
      } catch {
        // Contexto ou montagem inválida nunca pode afetar a chamada original.
      }
    },
  }
}
