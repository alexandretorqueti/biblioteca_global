/**
 * Erro padronizado do cliente — espelha o contrato ApiError do back.
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "ApiClientError"
  }

  static fromResponse(status: number, body: unknown): ApiClientError {
    if (body && typeof body === "object" && "code" in body) {
      const erro = body as {
        code: string
        message?: string
        details?: unknown
      }
      return new ApiClientError(
        status,
        erro.code,
        erro.message ?? "Erro",
        erro.details,
      )
    }
    return new ApiClientError(status, `HTTP_${status}`, "Erro inesperado")
  }
}
