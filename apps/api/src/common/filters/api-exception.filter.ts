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
import { EnvService } from "../../config/env.service"

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
  constructor(private readonly env: EnvService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>()

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const corpo = exception.getResponse()
      const mensagem =
        typeof corpo === "string"
          ? corpo
          : typeof corpo === "object" && corpo !== null && "message" in corpo
            ? (corpo as { message: unknown }).message
            : (exception.message ?? "Erro")
      const details =
        typeof corpo === "object" && corpo !== null && "details" in corpo
          ? (corpo as { details: unknown }).details
          : typeof corpo === "string"
            ? corpo
            : typeof corpo === "object" && corpo !== null
              ? "message" in corpo
                ? (corpo as { message: unknown }).message
                : exception.message
              : exception.message

      const erro: ApiError = {
        code: CODIGOS_POR_STATUS[status] ?? `HTTP_${status}`,
        message: typeof mensagem === "string" ? mensagem : "Erro",
        details: this.env.exposeRealErrors
          ? {
              response: corpo,
              stack: exception.stack,
            }
          : details,
      }
      response.status(status).json(erro)
      return
    }

    console.error("Exceção não tratada:", exception)
    const mensagemReal =
      exception instanceof Error ? exception.message : String(exception)
    const detalhesReais = exception instanceof Error
      ? { name: exception.name, message: exception.message, stack: exception.stack }
      : { value: String(exception) }
    const erro: ApiError = {
      code: "INTERNAL_ERROR",
      message: this.env.exposeRealErrors
        ? mensagemReal
        : "Erro interno do servidor",
      details: this.env.exposeRealErrors ? detalhesReais : undefined,
    }
    response.status(500).json(erro)
  }
}
