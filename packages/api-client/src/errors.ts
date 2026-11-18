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
    // Corpo sem `code` (ex.: 403 {status:"suspenso"} do tenants.controller,
    // que bypassa o filtro de exceções): preserva o body em `details` para o
    // cliente poder discriminar o estado sem parsing de mensagem.
    return new ApiClientError(status, `HTTP_${status}`, "Erro inesperado", body)
  }
}
