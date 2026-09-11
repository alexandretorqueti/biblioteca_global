import { describe, expect, it, vi } from "vitest"
import { BadRequestException, NotFoundException } from "@nestjs/common"
import { ApiExceptionFilter } from "../api-exception.filter"
import type { EnvService } from "../../../config/env.service"

interface MockResponse {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function criarHost(
  response: MockResponse,
  request: Record<string, unknown> = {},
): Parameters<ApiExceptionFilter["catch"]>[1] {
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as Parameters<ApiExceptionFilter["catch"]>[1]
}

function criarResponse(): MockResponse {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  }
  response.status.mockReturnValue(response)
  return response
}

function criarEnv(exposeRealErrors: boolean): EnvService {
  return { exposeRealErrors } as EnvService
}

describe("ApiExceptionFilter", () => {
  it("mantém erro inesperado sanitizado por padrão", () => {
    const response = criarResponse()
    const filtro = new ApiExceptionFilter(criarEnv(false))

    filtro.catch(new Error("SQL secreto"), criarHost(response))

    expect(response.status).toHaveBeenCalledWith(500)
    expect(response.json).toHaveBeenCalledWith({
      code: "INTERNAL_ERROR",
      message: "Erro interno do servidor",
      details: undefined,
    })
  })

  it("envia mensagem e stack quando o diagnóstico está ativado", () => {
    const response = criarResponse()
    const erro = new Error("SQL secreto")
    const filtro = new ApiExceptionFilter(criarEnv(true))

    filtro.catch(erro, criarHost(response))

    expect(response.status).toHaveBeenCalledWith(500)
    expect(response.json).toHaveBeenCalledWith({
      code: "INTERNAL_ERROR",
      message: "SQL secreto",
      details: {
        name: "Error",
        message: "SQL secreto",
        stack: erro.stack,
      },
    })
  })

  it("não marca como validação um 400 sem marcador explícito", () => {
    const response = criarResponse()
    const filtro = new ApiExceptionFilter(criarEnv(false))

    filtro.catch(new BadRequestException("Campo inválido"), criarHost(response))

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      code: "BAD_REQUEST",
      message: "Campo inválido",
      details: "Campo inválido",
    })
  })

  it("respeita o código explícito enviado no payload", () => {
    const response = criarResponse()
    const filtro = new ApiExceptionFilter(criarEnv(false))

    filtro.catch(
      new BadRequestException({ code: "FK_INEXISTENTE", message: "projeto_id inexistente" }),
      criarHost(response),
    )

    expect(response.json).toHaveBeenCalledWith({
      code: "FK_INEXISTENTE",
      message: "projeto_id inexistente",
      details: "projeto_id inexistente",
    })
  })

  it("preserva a mensagem do corpo em erros de validação estruturados", () => {
    const response = criarResponse()
    const filtro = new ApiExceptionFilter(criarEnv(false))

    filtro.catch(
      new BadRequestException({
        message: "Registro inválido",
        details: [{ caminho: "slug", problema: "Too big" }],
      }),
      criarHost(response),
    )

    expect(response.json).toHaveBeenCalledWith({
      code: "VALIDATION_ERROR",
      message: "Registro inválido",
      details: [{ caminho: "slug", problema: "Too big" }],
    })
  })

  it("registra o erro no projeto do escopo com a chave canônica do endpoint", async () => {
    const response = criarResponse()
    const criarTarefaErro = vi.fn().mockResolvedValue(undefined)
    const request = {
      method: "get",
      originalUrl: "/api/taqui/clientes/12?busca=maria",
      scope: { projeto: { id: 23, slug: "taqui" } },
    }
    const filtro = new ApiExceptionFilter(criarEnv(false), { criarTarefaErro })
    const exception = new BadRequestException("Coluna desconhecida: foo")

    filtro.catch(exception, criarHost(response, request))
    await vi.waitFor(() => expect(criarTarefaErro).toHaveBeenCalledOnce())

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      code: "BAD_REQUEST",
      message: "Coluna desconhecida: foo",
      details: "Coluna desconhecida: foo",
    })
    expect(criarTarefaErro).toHaveBeenCalledWith(expect.objectContaining({
      projetoId: 23,
      endpoint: "GET /api/taqui/clientes/:id",
      method: "get",
      status: 400,
    }))
  })

  it("não registra tarefa para 404 nem para validação de entrada", async () => {
    const criarTarefaErro = vi.fn().mockResolvedValue(undefined)
    const filtro = new ApiExceptionFilter(criarEnv(false), { criarTarefaErro })
    const request = {
      method: "get",
      originalUrl: "/api/taqui/clientes/12",
      scope: { projeto: { id: 23, slug: "taqui" } },
    }

    filtro.catch(new NotFoundException("Registro não encontrado"), criarHost(criarResponse(), request))
    filtro.catch(
      new BadRequestException({
        message: "Registro inválido",
        details: [{ caminho: "slug", problema: "Too big" }],
      }),
      criarHost(criarResponse(), request),
    )

    // O registro é assíncrono: dar uma volta no event loop antes de concluir.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(criarTarefaErro).not.toHaveBeenCalled()
  })

  it("usa o projeto do token quando o erro ocorre antes do scope", async () => {
    const criarTarefaErro = vi.fn().mockResolvedValue(undefined)
    const filtro = new ApiExceptionFilter(criarEnv(false), { criarTarefaErro })

    filtro.catch(new BadRequestException(" inválido "), criarHost(criarResponse(), {
      method: "post",
      originalUrl: "/api/clientes",
      authClaims: { sub: 7, projetoId: 41, perfil: "admin" },
    }))
    await vi.waitFor(() => expect(criarTarefaErro).toHaveBeenCalledOnce())

    expect(criarTarefaErro).toHaveBeenCalledWith(expect.objectContaining({
      projetoId: 41,
      endpoint: "POST /api/clientes",
    }))
  })

  it("não mascara a resposta quando o registro falha", async () => {
    const response = criarResponse()
    const erroDoRegistro = new Error("banco indisponível")
    const criarTarefaErro = vi.fn().mockRejectedValue(erroDoRegistro)
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const filtro = new ApiExceptionFilter(criarEnv(false), { criarTarefaErro })

    filtro.catch(new Error("falha do endpoint"), criarHost(response, {
      method: "get",
      url: "/api/falha",
      scope: { projeto: { id: 23 } },
    }))
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(response.status).toHaveBeenCalledWith(500)
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "INTERNAL_ERROR",
    }))
    log.mockRestore()
  })
})
