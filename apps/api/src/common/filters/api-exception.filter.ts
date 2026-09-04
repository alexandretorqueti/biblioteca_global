/**
 * Filtro global de exceções → resposta ApiError padronizada
 * (contrato ApiError do packages/shared; PoC §6.1).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Optional,
  Inject,
} from "@nestjs/common"
import type { ApiError } from "@biblioteca-global/shared"
import { EnvService } from "../../config/env.service"
import { GESTAO_GLOBAL_TASKS_REPOSITORY } from "../types"
import type { ApiRequest } from "../types"
import type { GestaoGlobalTasksRepository } from "../../modules/crud/gestao-global-tasks.repository"

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
  constructor(
    private readonly env: EnvService,
    @Optional() @Inject(GESTAO_GLOBAL_TASKS_REPOSITORY)
    private readonly tasksRepository?: GestaoGlobalTasksRepository,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const response = http.getResponse<HttpResponse>()
    const request = "getRequest" in http
      ? http.getRequest<ApiRequest>()
      : ({} as ApiRequest)

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
      this.registrarTarefa(request, status, erro.message, erro.details)
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
    this.registrarTarefa(request, 500, erro.message, erro.details)
  }

  private registrarTarefa(request: ApiRequest, status: number, message: string, details: unknown): void {
    const projetoId = request.scope?.projeto.id
    const endpoint = request.route?.path ?? request.originalUrl ?? request.url
    if (!this.tasksRepository || projetoId === undefined || !endpoint) return
    void this.tasksRepository.criarTarefaErro({
      projetoId,
      endpoint,
      method: request.method ?? "HTTP",
      status,
      message,
      details,
    }).catch((erro: unknown) => {
      console.error("Falha ao registrar tarefa de erro da API:", erro)
    })
  }
}
