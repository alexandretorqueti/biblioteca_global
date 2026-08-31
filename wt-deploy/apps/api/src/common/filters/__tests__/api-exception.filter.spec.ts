import { describe, expect, it, vi } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { ApiExceptionFilter } from "../api-exception.filter"
import type { EnvService } from "../../../config/env.service"

interface MockResponse {
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function criarHost(response: MockResponse): Parameters<ApiExceptionFilter["catch"]>[1] {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
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

  it("preserva a resposta HTTP amigável quando o diagnóstico está desligado", () => {
    const response = criarResponse()
    const filtro = new ApiExceptionFilter(criarEnv(false))

    filtro.catch(new BadRequestException("Campo inválido"), criarHost(response))

    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({
      code: "VALIDATION_ERROR",
      message: "Campo inválido",
      details: "Campo inválido",
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
})
