// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { BadRequestException, NotFoundException } from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import { EncomendasRegistroService } from "../encomendas-registro.service"

/**
 * Testes unitários do EncomendasRegistroService.
 *
 * Estratégia: mock do ProjectDbFactory com fake DB que simula os métodos
 * usados pelo service (select, insert, where, limit, groupBy). Os testes
 * verificam validações de contexto (condomínio), fluxo de notificação,
 * e tratamento de erros.
 *
 * Nota importante: `fakeChain` NÃO pode ter `.then` quando é usado como valor
 * resolvido direto de `mockResolvedValue(fakeChain)`, porque o await do
 * JavaScript trata objetos com `.then` como thenables e os desembrulha,
 * retornando o que o `.then` resolve em vez do objeto original. A solução é
 * empacotar o fakeChain em um wrapper sem `.then` (objeto `db`).
 */

function projeto(slug: string, id: number): ProjetoResumo {
  return { id, nome: slug, slug, perfil: "admin" }
}

/** Retorna um factory mock pronto para passar ao serviço. */
function makeMockFactory(db: Record<string, unknown>): ProjectDbFactory & { obter: ReturnType<typeof vi.fn> } {
  const obter = vi.fn().mockResolvedValue(db)
  return { obter } as unknown as ProjectDbFactory & { obter: ReturnType<typeof vi.fn> }
}

describe("EncomendasRegistroService — validações de contexto", () => {
  it("buscarUnidades com database ausente → 404", async () => {
    const factory = makeMockFactory({})
    factory.obter.mockRejectedValue({ code: "ER_BAD_DB_ERROR" })

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.buscarUnidades(projeto("taqui", 6611), { limit: 20, ativo: true }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("buscarUnidades sem condomínio ativo → 404", async () => {
    const chainPromise = Promise.resolve([])
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => chainPromise,
      then: chainPromise.then.bind(chainPromise),
    }

    // DB wrapper sem .then para evitar desembrulhamento via thenable.
    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => fakeChain }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.buscarUnidades(projeto("taqui", 6611), { limit: 20, ativo: true }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("registrar com unidade de outro condomínio → 400", async () => {
    let selectCallCount = 0
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([])
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => fakeChain }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.registrar(projeto("taqui", 6611), {
        unidadeId: 999,
        registradoPorId: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("registrar com funcionário inativo → 400", async () => {
    let selectCallCount = 0
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([{ id: 10, condominioId: 1 }])
        if (selectCallCount === 3) return Promise.resolve([])
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => fakeChain }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.registrar(projeto("taqui", 6611), {
        unidadeId: 10,
        registradoPorId: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("registrar com transportadora inativa → 400", async () => {
    let selectCallCount = 0
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([{ id: 10, condominioId: 1 }])
        if (selectCallCount === 3) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 4) return Promise.resolve([])
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => fakeChain }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.registrar(projeto("taqui", 6611), {
        unidadeId: 10,
        registradoPorId: 1,
        transportadoraId: 999,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe("EncomendasRegistroService — notificação", () => {
  it("falha de notificação é registrada mas não impede o registro", async () => {
    let selectCallCount = 0
    const insertCalls: Array<{ values: unknown }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([{ id: 10, condominioId: 1 }])
        if (selectCallCount === 3) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 4) return Promise.resolve([{ id: 5 }])
        if (selectCallCount === 5) return Promise.resolve([{ id: 1, nome: "João" }])
        if (selectCallCount === 6) return Promise.resolve([{ id: 100, status: "pendente" }])
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: (_table: unknown) => ({
        values: (_vals: unknown) => {
          insertCalls.push({ values: _vals })
          if (insertCalls.length === 2) {
            return { then: (_resolve: unknown, reject: (e: Error) => void) => reject(new Error("DB connection lost")) }
          }
          return { then: (resolve: (v: unknown) => void) => resolve([{ insertId: 100 }]) }
        },
      }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    const result = await service.registrar(projeto("taqui", 6611), {
      unidadeId: 10,
      registradoPorId: 1,
    })

    expect(result.encomenda).toBeDefined()
    expect(result.notificacao.enviada).toBe(false)
    expect(result.notificacao.erro).toContain("DB connection lost")
    expect(result.notificacao.totalMoradores).toBe(1)
  })
})

describe("EncomendasRegistroService — foto", () => {
  it("registro sem foto gera exceção na resposta", async () => {
    let selectCallCount = 0
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([{ id: 10, condominioId: 1 }])
        if (selectCallCount === 3) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 4) return Promise.resolve([{ id: 5 }])
        if (selectCallCount === 5) return Promise.resolve([]) // Sem moradores
        if (selectCallCount === 6) return Promise.resolve([{ id: 100, status: "pendente" }])
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 100 }]) }) }),
    }

    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    const result = await service.registrar(projeto("taqui", 6611), {
      unidadeId: 10,
      registradoPorId: 1,
    })

    expect(result.encomenda).toBeDefined()
    expect(result.notificacao.totalMoradores).toBe(0)
    expect(result.notificacao.enviada).toBe(false)
  })
})

describe("EncomendasRegistroService — busca de unidades", () => {
  it("busca sem termo retorna unidades do condomínio", async () => {
    let selectCallCount = 0
    const unidadesMock = [
      { id: 1, condominioId: 1, label: "Rua A, Bloco 1, Apto 101", tipo: "apartamento" as const, rua: "Rua A", bloco: "1", andar: 1, numero: "101", quadra: null, lote: null, ativo: true },
      { id: 2, condominioId: 1, label: "Rua A, Bloco 1, Apto 102", tipo: "apartamento" as const, rua: "Rua A", bloco: "1", andar: 1, numero: "102", quadra: null, lote: null, ativo: true },
    ]
    const moradoresMock = [
      { id: 1, unidadeId: 1, nome: "João Silva", ativo: true },
      { id: 2, unidadeId: 2, nome: "Maria Santos", ativo: true },
    ]

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve(unidadesMock)
        if (selectCallCount === 3) return Promise.resolve(moradoresMock)
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = { select: () => fakeChain, insert: () => ({ values: () => fakeChain }) }
    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    const result = await service.buscarUnidades(projeto("taqui", 6611), { limit: 20, ativo: true })

    expect(result).toHaveLength(2)
    expect(result[0]?.moradores).toHaveLength(1)
    expect(result[0]?.moradores[0]?.nome).toBe("João Silva")
  })

  it("busca com termo filtra por label e nome de morador", async () => {
    let selectCallCount = 0
    const unidadesMock = [
      { id: 1, condominioId: 1, label: "Rua A, Bloco 1, Apto 101", tipo: "apartamento" as const, rua: "Rua A", bloco: "1", andar: 1, numero: "101", quadra: null, lote: null, ativo: true },
    ]
    const moradoresMock = [
      { id: 1, unidadeId: 1, nome: "João Silva", ativo: true },
    ]

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve(unidadesMock)
        if (selectCallCount === 3) return Promise.resolve(moradoresMock)
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = { select: () => fakeChain, insert: () => ({ values: () => fakeChain }) }
    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    const result = await service.buscarUnidades(projeto("taqui", 6611), { q: "João", limit: 20, ativo: true })

    expect(result).toHaveLength(1)
    expect(result[0]?.moradores[0]?.nome).toBe("João Silva")
  })
})

describe("EncomendasRegistroService — busca de transportadoras", () => {
  it("retorna transportadoras ordenadas por frequência", async () => {
    let selectCallCount = 0
    const transportadorasMock = [
      { id: 1, nome: "Mercado Livre", cnpj: null, telefone: null, ativo: true },
      { id: 2, nome: "Amazon", cnpj: null, telefone: null, ativo: true },
      { id: 3, nome: "Shopee", cnpj: null, telefone: null, ativo: true },
    ]
    const frequenciasMock = [
      { transportadoraId: 2, count: 10 },
      { transportadoraId: 1, count: 5 },
    ]

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve(transportadorasMock)
        return Promise.resolve([])
      },
      groupBy: () => ({ then: (resolve: (v: unknown) => void) => resolve(frequenciasMock) }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = { select: () => fakeChain, insert: () => ({ values: () => fakeChain }) }
    const factory = makeMockFactory(db)

    const service = new EncomendasRegistroService(factory)
    const result = await service.buscarTransportadoras(projeto("taqui", 6611), { limit: 20 })

    expect(result).toHaveLength(3)
    expect(result[0]?.nome).toBe("Amazon")
    expect(result[0]?.frequencia).toBe(10)
    expect(result[1]?.nome).toBe("Mercado Livre")
    expect(result[1]?.frequencia).toBe(5)
    expect(result[2]?.nome).toBe("Shopee")
    expect(result[2]?.frequencia).toBe(0)
  })
})
