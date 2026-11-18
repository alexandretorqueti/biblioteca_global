// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { TransbordoController } from "../transbordo.controller"

const config = {
  ativo: true,
  destino: { tipo: "email", valor: "atendente@example.com", nomeAtendente: "Ana" },
  horario: { diasSemana: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00", timezone: "America/Sao_Paulo" },
} as const

describe("TransbordoController", () => {
  it("não grava outro tenant mesmo com payload válido", async () => {
    const service = { salvarConfig: vi.fn() }
    const controller = new TransbordoController(service as never)
    await expect(controller.atualizarConfig("outro", { slug: "meu-tenant" } as never, config)).rejects.toBeInstanceOf(BadRequestException)
    expect(service.salvarConfig).not.toHaveBeenCalled()
  })

  it("encaminha configuração do tenant autenticado", async () => {
    const service = { salvarConfig: vi.fn().mockResolvedValue(config) }
    const controller = new TransbordoController(service as never)
    await controller.atualizarConfig("meu-tenant", { slug: "meu-tenant" } as never, config)
    expect(service.salvarConfig).toHaveBeenCalledWith("meu-tenant", config)
  })
})
