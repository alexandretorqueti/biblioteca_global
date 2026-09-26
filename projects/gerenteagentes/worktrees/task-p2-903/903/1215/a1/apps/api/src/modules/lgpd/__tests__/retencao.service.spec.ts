import { describe, expect, it } from "vitest"
import { RetencaoService } from "../retencao.service"
import type { RetencaoRepository } from "../retencao.repository"

class FakeRetencaoRepository implements RetencaoRepository {
  ids: number[] = []
  desativados: number[] = []

  async encontrarInativosAntesDe(data: Date): Promise<number[]> {
    expect(data.toISOString()).toBe("2021-09-14T00:00:00.000Z")
    return this.ids
  }

  async desativarPorRetencao(usuarioId: number): Promise<void> {
    this.desativados.push(usuarioId)
  }
}

describe("RetencaoService", () => {
  it("identifica e desativa usuários sem atividade há cinco anos", async () => {
    const repo = new FakeRetencaoRepository()
    repo.ids = [4, 9]
    const resultado = await new RetencaoService(repo).executar(new Date("2026-09-14T00:00:00.000Z"))
    expect(resultado).toEqual({ desativados: 2 })
    expect(repo.desativados).toEqual([4, 9])
  })
})
