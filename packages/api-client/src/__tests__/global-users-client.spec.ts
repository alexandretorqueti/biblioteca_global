import { describe, expect, it, vi } from "vitest"
import { GlobalUsersClient } from "../global-users-client"

describe("GlobalUsersClient", () => {
  it("usa os endpoints globais e mantém conflito do servidor", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 100 })
      .mockRejectedValueOnce(new Error("Identificador já cadastrado"))
    const client = new GlobalUsersClient({ request } as never)

    await client.list()
    await expect(client.create({ nome: "Ana", senhaInicial: "senha-123" })).rejects.toThrow("cadastrado")
    expect(request).toHaveBeenNthCalledWith(1, "GET", "/usuarios/gerais", expect.objectContaining({ auth: "access" }))
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/usuarios/gerais", expect.objectContaining({ body: expect.objectContaining({ nome: "Ana" }) }))
  })

  it("administra vínculos com adicionar, alterar perfil e remover", async () => {
    const request = vi.fn().mockResolvedValue({ usuarioId: 7 })
    const client = new GlobalUsersClient({ request } as never)
    await client.updateLinks(7, { adicionar: [{ projetoId: 2, perfil: "admin" }] })
    await client.updateLinks(7, { adicionar: [{ projetoId: 2, perfil: "operador" }] })
    await client.updateLinks(7, { remover: [2] })
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/usuarios/7/vinculos", expect.objectContaining({ body: { adicionar: [{ projetoId: 2, perfil: "admin" }] } }))
    expect(request).toHaveBeenNthCalledWith(3, "PUT", "/usuarios/7/vinculos", expect.objectContaining({ body: { remover: [2] } }))
  })
})
