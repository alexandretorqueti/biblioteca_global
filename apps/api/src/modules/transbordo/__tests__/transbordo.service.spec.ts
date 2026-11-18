// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { TransbordoService } from "../transbordo.service"

const config = {
  ativo: true,
  destino: { tipo: "telegram", valor: "@atendente", nomeAtendente: "Ana" },
  horario: { diasSemana: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00", timezone: "America/Sao_Paulo" },
} as const

function mockDb(existing: boolean) {
  const updateWhere = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue(existing ? [{ id: 4 }] : []) }) }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue([{ insertId: 9 }]) })),
  }
  return { db, updateWhere }
}

describe("TransbordoService", () => {
  it("cria a configuração do tenant", async () => {
    const { db } = mockDb(false)
    const result = await new TransbordoService(db as never).salvarConfig("tenant-a", config)
    expect(result).toEqual(config)
    expect(db.insert).toHaveBeenCalled()
    expect(db.update).not.toHaveBeenCalled()
  })

  it("atualiza somente a configuração já existente do tenant", async () => {
    const { db } = mockDb(true)
    await new TransbordoService(db as never).salvarConfig("tenant-a", config)
    expect(db.update).toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
  })

  it("valida antes de acessar o banco", async () => {
    const { db } = mockDb(false)
    await expect(new TransbordoService(db as never).salvarConfig("tenant-a", { ...config, destino: { ...config.destino, tipo: "sms" } })).rejects.toBeInstanceOf(BadRequestException)
    expect(db.select).not.toHaveBeenCalled()
  })

  it("aceita a primeira liberação e rejeita reutilização pelo affectedRows", async () => {
    const { db, updateWhere } = mockDb(false)
    const service = new TransbordoService(db as never)
    updateWhere.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await service.liberarPorToken("token" + "-seguro")).toBe(true)
    expect(await service.liberarPorToken("token" + "-seguro")).toBe(false)
  })
})
