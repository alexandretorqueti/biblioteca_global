/**
 * Filtro global de exceções → resposta ApiError padronizada
 * (contrato ApiError do packages/shared; PoC §6.1).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common"
import type { ApiError } from "@biblioteca-global/shared"

interface HttpResponse {
  status(code: number): HttpResponse
  json(body: unknown): HttpResponse
}

const CODIGOS_POR_STATUS: Record<number, string> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const corpo = exception.getResponse()
      const mensagem =
        typeof corpo === "string" ? corpo : (exception.message ?? "Erro")
      const details =
        typeof corpo === "object" && corpo !== null && "message" in corpo
          ? (corpo as { message: unknown }).message
          : undefined

      const erro: ApiError = {
        code: CODIGOS_POR_STATUS[status] ?? `HTTP_${status}`,
        message: typeof mensagem === "string" ? mensagem : "Erro",
        details,
      }
      response.status(status).json(erro)
      return
    }

    console.error("Exceção não tratada:", exception)
    const erro: ApiError = {
      code: "INTERNAL_ERROR",
      message: "Erro interno do servidor",
    }
    response.status(500).json(erro)
  }
}
