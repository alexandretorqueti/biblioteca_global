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
import {
  CODIGO_ERRO_VALIDACAO,
  erroReportavel,
  montarEndpointCanonico,
  type ApiError,
} from "@biblioteca-global/shared"
import { EnvService } from "../../config/env.service"
import { GESTAO_GLOBAL_TASKS_REPOSITORY } from "../types"
import type { ApiRequest } from "../types"

interface ErrorTaskRegistrar {
  criarTarefaErro(input: {
    projetoId: number
    endpoint: string
    method?: string
    status?: number
    message: string
    details?: unknown
  }): Promise<unknown>
}

interface HttpResponse {
  status(code: number): HttpResponse
  json(body: unknown): HttpResponse
}

/**
 * Código por status. O 400 NÃO vira `VALIDATION_ERROR` por padrão: o CRUD
 * genérico usa o mesmo status para validação da entrada (Zod, com `details`
 * estruturado) e para defeitos reais (FK inexistente, coluna desconhecida).
 * Marcar todo 400 como validação esconderia defeito real da política
 * (`erroReportavel`), que decide se a ocorrência vira tarefa.
 */
const CODIGOS_POR_STATUS: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: CODIGO_ERRO_VALIDACAO,
  429: "RATE_LIMITED",
}

/**
 * Código canônico da resposta (`ApiError.code`).
 *
 * O hint explícito vence: o payload pode trazer `code` (contrato de validação
 * da subtarefa 1) ou a forma do ValidationPipe do Nest/Zod — `details`
 * estruturado com a lista de problemas por campo (400/422 apenas). Sem
 * marcador, vale a tabela por status.
 */
function codigoDoErro(status: number, corpo: unknown): string {
  if (corpo !== null && typeof corpo === "object") {
    const objeto = corpo as { code?: unknown; details?: unknown; message?: unknown }
    if (typeof objeto.code === "string" && objeto.code.trim() !== "") {
      return objeto.code.trim()
    }
    if (
      (status === 400 || status === 422) &&
      (Array.isArray(objeto.details) || Array.isArray(objeto.message))
    ) {
      return CODIGO_ERRO_VALIDACAO
    }
  }
  return CODIGOS_POR_STATUS[status] ?? `HTTP_${status}`
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly env: EnvService,
    @Optional() @Inject(GESTAO_GLOBAL_TASKS_REPOSITORY)
    private readonly tasksRepository?: ErrorTaskRegistrar,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const response = http.getResponse<HttpResponse>()
    const request = http.getRequest<ApiRequest>()

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
        code: codigoDoErro(status, corpo),
        message: typeof mensagem === "string" ? mensagem : "Erro",
        details: this.env.exposeRealErrors
          ? {
              response: corpo,
              stack: exception.stack,
            }
          : details,
      }
      response.status(status).json(erro)
      this.registrarTarefa(request, status, erro.code, erro.message, erro.details)
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
    this.registrarTarefa(request, 500, erro.code, erro.message, erro.details)
  }

  private registrarTarefa(
    request: ApiRequest,
    status: number,
    code: string,
    message: string,
    details: unknown,
  ): void {
    // O scope só é preenchido pelo ProjectScopeGuard. Em erros lançados por
    // guards anteriores, o claim já validado ainda identifica o projeto.
    const projetoId = request.scope?.projeto.id ?? request.authClaims?.projetoId
    const method = request.method ?? "HTTP"
    // Caminho efetivamente chamado — a chave canônica precisa ser a MESMA que
    // o front monta (senão a deduplicação por endpoint nunca casa).
    const caminho = request.originalUrl ?? request.url ?? request.route?.path
    if (!this.tasksRepository || projetoId === undefined || !caminho) return

    // Política central do shared (subtarefa 2): só erro com indício de defeito
    // real vira tarefa. 404 e validação de entrada ficam de fora.
    const decisao = erroReportavel({ status, code, origem: { rota: caminho } })
    if (!decisao.reportavel) return

    const endpoint = montarEndpointCanonico({
      method,
      path: caminho,
      slug: request.scope?.projeto.slug,
    })

    // Promise.resolve().then também captura uma exceção síncrona de um mock ou
    // implementação defeituosa do repositório. O registro é deliberadamente
    // assíncrono e nunca pode alterar a resposta já enviada ao cliente.
    void Promise.resolve()
      .then(() => this.tasksRepository?.criarTarefaErro({
        projetoId,
        endpoint,
        method,
        status,
        message,
        details,
      }))
      .catch((erro: unknown) => {
        console.error("Falha ao registrar tarefa de erro da API:", erro)
      })
  }
}
