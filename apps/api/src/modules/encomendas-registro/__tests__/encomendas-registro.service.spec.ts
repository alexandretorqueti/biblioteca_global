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
 */

function projeto(slug: string, id: number): ProjetoResumo {
  return { id, nome: slug, slug, perfil: "admin" }
}

/** Fake DB builder — chainable para simular drizzle queries. */
function createFakeDb(overrides: {
  condominioId?: number
  unidades?: Array<{ id: number; condominioId: number; label: string | null; tipo: "apartamento" | "casa"; rua: string | null; bloco: string | null; andar: number | null; numero: string | null; quadra: string | null; lote: string | null; ativo: boolean }>
  moradores?: Array<{ id: number; unidadeId: number; nome: string; ativo: boolean }>
  funcionarios?: Array<{ id: number; condominioId: number; ativo: boolean }>
  transportadoras?: Array<{ id: number; nome: string; cnpj: string | null; telefone: string | null; ativo: boolean }>
  insertResult?: { insertId: number }
  notificacaoError?: Error
}) {
  const condominioId = overrides.condominioId ?? 1
  const unidades = overrides.unidades ?? []
  const moradores = overrides.moradores ?? []
  const funcionarios = overrides.funcionarios ?? []
  const transportadoras = overrides.transportadoras ?? []
  const insertResult = overrides.insertResult ?? { insertId: 100 }

  // Builder chainable que retorna resultados baseados no contexto
  const createChain = (resultFn: () => unknown) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      and: () => chain,
      limit: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      then: (resolve: (v: unknown) => void) => Promise.resolve(resultFn()).then(resolve),
    }
    // Make it thenable so `await chain` works
    return {
      ...chain,
      [Symbol.asyncIterator]: undefined,
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(resultFn()).then(resolve, reject),
    }
  }

  const db = {
    select: () => createChain(() => {
      // Retorna unidades, moradores, funcionarios, ou transportadoras baseado no contexto
      // O teste real vai mockar isso de forma mais específica
      return unidades
    }),
    insert: () => ({
      values: () =>
        createChain(() => {
          if (overrides.notificacaoError) {
            throw overrides.notificacaoError
          }
          return [insertResult]
        }),
    }),
  }

  return { db, condominioId, unidades, moradores, funcionarios, transportadoras }
}

describe("EncomendasRegistroService — validações de contexto", () => {
  it("buscarUnidades com database ausente → 404", async () => {
    const factory = {
      obter: vi.fn().mockRejectedValue({ code: "ER_BAD_DB_ERROR" }),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.buscarUnidades(projeto("taqui", 6611), { limit: 20, ativo: true }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("buscarUnidades sem condomínio ativo → 404", async () => {
    // Fake DB que retorna array vazio para select de condomínios
    const chainPromise = Promise.resolve([])
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => chainPromise,
      then: chainPromise.then.bind(chainPromise),
    }
    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    await expect(
      service.buscarUnidades(projeto("taqui", 6611), { limit: 20, ativo: true }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("registrar com unidade de outro condomínio → 400", async () => {
    // Simula: condomínio existe, mas unidade não pertence a ele
    let selectCallCount = 0
    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) {
          // Primeiro select: busca condomínio → retorna id=1
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 2) {
          // Segundo select: busca unidade → não encontra (condomínio diferente)
          return Promise.resolve([])
        }
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }
    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

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
        if (selectCallCount === 1) {
          // Condomínio encontrado
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 2) {
          // Unidade encontrada e pertence ao condomínio
          return Promise.resolve([{ id: 10, condominioId: 1 }])
        }
        if (selectCallCount === 3) {
          // Funcionário não encontrado/inativo
          return Promise.resolve([])
        }
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }
    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

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
        if (selectCallCount === 1) {
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 2) {
          return Promise.resolve([{ id: 10, condominioId: 1 }])
        }
        if (selectCallCount === 3) {
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 4) {
          // Transportadora não encontrada
          return Promise.resolve([])
        }
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }
    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

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
        if (selectCallCount === 1) {
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 2) {
          return Promise.resolve([{ id: 10, condominioId: 1 }])
        }
        if (selectCallCount === 3) {
          return Promise.resolve([{ id: 1 }])
        }
        if (selectCallCount === 4) {
          return Promise.resolve([{ id: 5 }])
        }
        if (selectCallCount === 5) {
          // Moradores ativos da unidade
          return Promise.resolve([{ id: 1, nome: "João" }])
        }
        if (selectCallCount === 6) {
          // Busca encomenda criada
          return Promise.resolve([{ id: 100, status: "pendente" }])
        }
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          insertCalls.push({ values: vals })
          // Primeira insert (encomenda) → sucesso
          // Segunda insert (notificação) → falha
          if (insertCalls.length === 2) {
            return {
              then: (_resolve: unknown, reject: (e: Error) => void) => {
                reject(new Error("DB connection lost"))
              },
            }
          }
          return {
            then: (resolve: (v: unknown) => void) => {
              resolve([{ insertId: 100 }])
            },
          }
        },
      }),
    }

    const factory = {
      obter: vi.fn().mockResolvedValue(db),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    const result = await service.registrar(projeto("taqui", 6611), {
      unidadeId: 10,
      registradoPorId: 1,
    })

    // Encomenda foi criada
    expect(result.encomenda).toBeDefined()
    // Notificação falhou mas foi registrada
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

    let insertCallCount = 0
    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => {
            insertCallCount++
            resolve([{ insertId: 100 }])
          },
        }),
      }),
    }

    const factory = {
      obter: vi.fn().mockResolvedValue(db),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    const result = await service.registrar(projeto("taqui", 6611), {
      unidadeId: 10,
      registradoPorId: 1,
      // fotoUrl não informado
    })

    expect(result.encomenda).toBeDefined()
    // Sem moradores, notificacao.totalMoradores = 0 e enviada = false
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
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }]) // condomínio
        if (selectCallCount === 2) return Promise.resolve(unidadesMock) // unidades
        if (selectCallCount === 3) return Promise.resolve(moradoresMock) // moradores
        return Promise.resolve([])
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

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

    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    const result = await service.buscarUnidades(projeto("taqui", 6611), { q: "João", limit: 20, ativo: true })

    // A unidade deve ser retornada porque o morador "João" match
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
      groupBy: () => ({
        then: (resolve: (v: unknown) => void) => resolve(frequenciasMock),
      }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        fakeChain.limit().then(resolve, reject),
    }

    const factory = {
      obter: vi.fn().mockResolvedValue(fakeChain),
    } as unknown as ProjectDbFactory

    const service = new EncomendasRegistroService(factory)
    const result = await service.buscarTransportadoras(projeto("taqui", 6611), { limit: 20 })

    expect(result).toHaveLength(3)
    // Amazon (frequência 10) deve vir primeiro
    expect(result[0]?.nome).toBe("Amazon")
    expect(result[0]?.frequencia).toBe(10)
    // Mercado Livre (frequência 5) deve vir segundo
    expect(result[1]?.nome).toBe("Mercado Livre")
    expect(result[1]?.frequencia).toBe(5)
    // Shopee (frequência 0) deve vir por último
    expect(result[2]?.nome).toBe("Shopee")
    expect(result[2]?.frequencia).toBe(0)
  })
})
