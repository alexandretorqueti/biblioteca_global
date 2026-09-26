// @vitest-environment node
/**
 * Testes unitários do OcorrenciasService — foco em cancelamento/devolução.
 *
 * Estratégia: mock do ProjectDbFactory com fake DB. Os testes verificam:
 * - Registro de ocorrência com cancelamento da encomenda
 * - Registro de ocorrência sem cancelamento (tipo endereco_incorreto/outro)
 * - Isolamento multi-tenant (encomenda de outro condomínio)
 * - Validação de funcionário
 * - Notificação aos moradores após ocorrência
 * - Histórico de ocorrências respeita isolamento
 */
import { describe, expect, it, vi } from "vitest"
import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import { OcorrenciasService } from "../ocorrencias.service"
import type { RegistroOcorrenciaBody } from "../dto/registro-ocorrencia-body.dto"

function projeto(slug: string, id: number): ProjetoResumo {
  return { id, nome: slug, slug, perfil: "operador" }
}

function makeMockFactory(
  db: Record<string, unknown>,
): ProjectDbFactory & { obter: ReturnType<typeof vi.fn> } {
  const obter = vi.fn().mockResolvedValue(db)
  return { obter } as unknown as ProjectDbFactory & {
    obter: ReturnType<typeof vi.fn>
  }
}

const bodyOcorrenciaDevolucao: RegistroOcorrenciaBody = {
  encomendaId: 500,
  tipo: "devolucao_transportadora",
  motivo: "Transportadora voltou para buscar a encomenda por erro de endereço",
  devolvidaTransportadora: true,
}

const bodyOcorrenciaExtravio: RegistroOcorrenciaBody = {
  encomendaId: 500,
  tipo: "extravio",
  motivo: "Encomenda extraviada durante manuseio na portaria",
  devolvidaTransportadora: false,
}

const bodyOcorrenciaRecusada: RegistroOcorrenciaBody = {
  encomendaId: 500,
  tipo: "recusada",
  motivo: "Morador recusou o recebimento por não reconhecer o remetente",
  devolvidaTransportadora: false,
}

describe("OcorrenciasService — cancelamento via ocorrência", () => {
  it("devolução pela transportadora cancela a encomenda", async () => {
    let selectCallCount = 0
    const insertCalls: Array<{ values: unknown }> = []
    const updateCalls: Array<{ set: Record<string, unknown> }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        // 1: condomínio
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        // 2: encomenda
        if (selectCallCount === 2)
          return Promise.resolve([
            {
              id: 500,
              condominioId: 1,
              unidadeId: 100,
              status: "pendente",
            },
          ])
        // 3: funcionário
        if (selectCallCount === 3)
          return Promise.resolve([{ id: 1, nome: "Carlos Portaria" }])
        // 4: unidade (para mensagem)
        if (selectCallCount === 4)
          return Promise.resolve([{ id: 100, label: "Rua A, Apto 101" }])
        // 5: moradores ativos
        if (selectCallCount === 5)
          return Promise.resolve([{ id: 10, nome: "João" }])
        // 6: ocorrência criada
        if (selectCallCount === 6)
          return Promise.resolve([
            {
              id: 3000,
              encomendaId: 500,
              condominioId: 1,
              registradoPorId: 1,
              tipo: "devolucao_transportadora",
              motivo: bodyOcorrenciaDevolucao.motivo,
            },
          ])
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: (vals: unknown) => {
          insertCalls.push({ values: vals })
          return {
            then: (resolve: (v: unknown) => void) =>
              resolve([{ insertId: 3000 }]),
          }
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push({ set: vals })
            return { then: (resolve: (v: unknown) => void) => resolve([1]) }
          },
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const result = await service.registrar(
      projeto("taqui", 6611),
      bodyOcorrenciaDevolucao,
      1,
    )

    expect(result.encomenda.status).toBe("cancelada")
    expect(result.encomenda.atualizado).toBe(true)
    expect(result.notificacao.totalMoradores).toBe(1)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]?.set.status).toBe("cancelada")
    expect(updateCalls[0]?.set.canceladoPorId).toBe(1)
  })

  it("extravio cancela a encomenda", async () => {
    let selectCallCount = 0
    const updateCalls: Array<{ set: Record<string, unknown> }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pronta_retirada" },
          ])
        if (selectCallCount === 3)
          return Promise.resolve([{ id: 1, nome: "Carlos" }])
        if (selectCallCount === 4)
          return Promise.resolve([{ id: 100, label: "Rua A, Apto 101" }])
        if (selectCallCount === 5)
          return Promise.resolve([{ id: 10, nome: "João" }])
        if (selectCallCount === 6)
          return Promise.resolve([{ id: 3000 }])
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => resolve([{ insertId: 3000 }]),
        }),
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push({ set: vals })
            return { then: (resolve: (v: unknown) => void) => resolve([1]) }
          },
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const result = await service.registrar(
      projeto("taqui", 6611),
      bodyOcorrenciaExtravio,
      1,
    )

    expect(result.encomenda.status).toBe("cancelada")
    expect(result.encomenda.atualizado).toBe(true)
    expect(updateCalls[0]?.set.status).toBe("cancelada")
  })

  it("recusada pelo morador cancela a encomenda", async () => {
    let selectCallCount = 0
    const updateCalls: Array<{ set: Record<string, unknown> }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pendente" },
          ])
        if (selectCallCount === 3)
          return Promise.resolve([{ id: 1, nome: "Carlos" }])
        if (selectCallCount === 4)
          return Promise.resolve([{ id: 100, label: "Rua A, Apto 101" }])
        if (selectCallCount === 5)
          return Promise.resolve([]) // sem moradores
        if (selectCallCount === 6)
          return Promise.resolve([{ id: 3000 }])
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => resolve([{ insertId: 3000 }]),
        }),
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push({ set: vals })
            return { then: (resolve: (v: unknown) => void) => resolve([1]) }
          },
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const result = await service.registrar(
      projeto("taqui", 6611),
      bodyOcorrenciaRecusada,
      1,
    )

    expect(result.encomenda.status).toBe("cancelada")
    expect(result.encomenda.atualizado).toBe(true)
    expect(result.notificacao.totalMoradores).toBe(0)
    expect(result.notificacao.enviada).toBe(false)
  })

  it("endereco_incorreto NÃO cancela a encomenda (apenas registra)", async () => {
    let selectCallCount = 0
    const updateCalls: Array<{ set: Record<string, unknown> }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pendente" },
          ])
        if (selectCallCount === 3)
          return Promise.resolve([{ id: 1, nome: "Carlos" }])
        if (selectCallCount === 4)
          return Promise.resolve([{ id: 100, label: "Rua A, Apto 101" }])
        if (selectCallCount === 5)
          return Promise.resolve([{ id: 10, nome: "João" }])
        if (selectCallCount === 6)
          return Promise.resolve([{ id: 3000 }])
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => resolve([{ insertId: 3000 }]),
        }),
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push({ set: vals })
            return { then: (resolve: (v: unknown) => void) => resolve([1]) }
          },
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const bodyEnderecoIncorreto: RegistroOcorrenciaBody = {
      encomendaId: 500,
      tipo: "endereco_incorreto",
      motivo: "Unidade informada não existe no condomínio — verificar número",
      devolvidaTransportadora: false,
    }

    const result = await service.registrar(
      projeto("taqui", 6611),
      bodyEnderecoIncorreto,
      1,
    )

    // endereco_incorreto NÃO cancela a encomenda
    expect(result.encomenda.status).toBe("pendente")
    expect(result.encomenda.atualizado).toBe(false)
    expect(updateCalls).toHaveLength(0) // nenhum update na encomenda
  })
})

describe("OcorrenciasService — isolamento multi-tenant", () => {
  it("encomenda de outro condomínio → 400", async () => {
    let selectCallCount = 0

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([]) // encomenda não encontrada no condomínio
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }),
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    await expect(
      service.registrar(projeto("taqui", 6611), bodyOcorrenciaDevolucao, 1),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("funcionário de outro condomínio → 400", async () => {
    let selectCallCount = 0

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pendente" },
          ])
        if (selectCallCount === 3) return Promise.resolve([]) // funcionário não encontrado
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => ({
          then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }),
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    await expect(
      service.registrar(projeto("taqui", 6611), bodyOcorrenciaDevolucao, 999),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("database ausente → 404", async () => {
    const factory = makeMockFactory({})
    factory.obter.mockRejectedValue({ code: "ER_BAD_DB_ERROR" })

    const service = new OcorrenciasService(factory)

    await expect(
      service.registrar(projeto("taqui", 6611), bodyOcorrenciaDevolucao, 1),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe("OcorrenciasService — histórico", () => {
  it("listarPorEncomenda de outro condomínio → 404", async () => {
    let selectCallCount = 0

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2) return Promise.resolve([]) // encomenda não encontrada
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = { select: () => fakeChain }
    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    await expect(
      service.listarPorEncomenda(projeto("taqui", 6611), 500),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("listarPorEncomenda sem ocorrências → array vazio", async () => {
    let selectCallCount = 0

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pendente" },
          ])
        if (selectCallCount === 3) return Promise.resolve([]) // sem ocorrências
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    const db = { select: () => fakeChain }
    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const result = await service.listarPorEncomenda(projeto("taqui", 6611), 500)

    expect(result).toEqual([])
  })
})

describe("OcorrenciasService — notificação falha não impede registro", () => {
  it("falha de notificação é registrada mas ocorrência é criada", async () => {
    let selectCallCount = 0
    const insertCalls: Array<{ values: unknown; isNotification?: boolean }> = []

    const fakeChain = {
      select: () => fakeChain,
      from: () => fakeChain,
      where: () => fakeChain,
      orderBy: () => fakeChain,
      limit: () => {
        selectCallCount++
        if (selectCallCount === 1) return Promise.resolve([{ id: 1 }])
        if (selectCallCount === 2)
          return Promise.resolve([
            { id: 500, condominioId: 1, unidadeId: 100, status: "pendente" },
          ])
        if (selectCallCount === 3)
          return Promise.resolve([{ id: 1, nome: "Carlos" }])
        if (selectCallCount === 4)
          return Promise.resolve([{ id: 100, label: "Rua A, Apto 101" }])
        if (selectCallCount === 5)
          return Promise.resolve([{ id: 10, nome: "João" }])
        if (selectCallCount === 6)
          return Promise.resolve([{ id: 3000 }])
        return Promise.resolve([])
      },
      then: (
        resolve: (v: unknown) => void,
        reject?: (e: unknown) => void,
      ) => fakeChain.limit().then(resolve, reject),
    }

    let insertCallIndex = 0
    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: (vals: unknown) => {
          insertCallIndex++
          insertCalls.push({ values: vals, isNotification: insertCallIndex === 2 })
          // Segundo insert (notificação) falha
          if (insertCallIndex === 2) {
            return {
              then: (_resolve: unknown, reject: (e: Error) => void) =>
                reject(new Error("DB connection lost")),
            }
          }
          return {
            then: (resolve: (v: unknown) => void) =>
              resolve([{ insertId: 3000 }]),
          }
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }),
        }),
      }),
    }

    const factory = makeMockFactory(db)
    const service = new OcorrenciasService(factory)

    const result = await service.registrar(
      projeto("taqui", 6611),
      bodyOcorrenciaDevolucao,
      1,
    )

    // Ocorrência foi criada mesmo com falha de notificação
    expect(result.ocorrencia).toBeDefined()
    expect(result.encomenda.status).toBe("cancelada")
    expect(result.notificacao.enviada).toBe(false)
    expect(result.notificacao.erro).toContain("DB connection lost")
  })
})
