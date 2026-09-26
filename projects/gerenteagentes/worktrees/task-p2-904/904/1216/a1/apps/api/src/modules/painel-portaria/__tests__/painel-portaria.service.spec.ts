// @vitest-environment node
/**
 * Testes unitários do PainelPortariaService — foco no fluxo de entrega.
 *
 * Estratégia: mock do ProjectDbFactory com fake DB. Os testes verificam:
 * - Entrega com status pronta_retirada → sucesso (cria registro em entregas)
 * - Entrega sem confirmação (status pendente) → 409 Conflict
 * - Entrega de encomenda já entregue → 409 Conflict
 * - Entrega de encomenda cancelada → 409 Conflict
 * - Isolamento multi-tenant na entrega (encomenda de outro condomínio)
 * - Indisponibilidade de câmera/upload (fotoComprovanteUrl ausente é OK)
 */
import { describe, expect, it, vi } from "vitest"
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import { PainelPortariaService } from "../painel-portaria.service"
import type { EntregaBody } from "../dto/entrega-body.dto"

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

const bodyEntregaBasico: EntregaBody = {
  funcionarioId: 1,
  recebedorNome: "João Silva",
  recebedorDocumento: "123.456.789-00",
  recebedorVinculo: "proprio_morador",
}

/**
 * Cria uma fake chain com respostas sequenciais para .limit().
 */
function createFakeChain(responses: Array<() => unknown>) {
  let callIndex = 0
  const fakeChain: Record<string, unknown> = {
    select: () => fakeChain,
    from: () => fakeChain,
    where: () => fakeChain,
    orderBy: () => fakeChain,
    leftJoin: () => fakeChain,
    limit: () => {
      const response = responses[callIndex]
      callIndex++
      return response ? response() : Promise.resolve([])
    },
    offset: () => fakeChain,
  }
  fakeChain.then = (
    resolve: (v: unknown) => void,
    reject?: (e: unknown) => void,
  ) => ((fakeChain.limit as () => Promise<unknown>)().then(resolve, reject))
  return fakeChain
}

describe("PainelPortariaService — registro de entrega", () => {
  it("entrega com status pronta_retirada → sucesso", async () => {
    const insertCalls: Array<{ values: unknown }> = []
    const updateCalls: Array<{ set: Record<string, unknown> }> = []
    const agora = new Date()

    const fakeChain = createFakeChain([
      // 1: condomínio
      () => Promise.resolve([{ id: 1 }]),
      // 2: encomenda
      () => Promise.resolve([
        { id: 500, status: "pronta_retirada", condominioId: 1, unidadeId: 100 },
      ]),
      // 3: funcionário
      () => Promise.resolve([{ id: 1, nome: "Carlos Portaria" }]),
      // 4: select entrega criada (verificação)
      () => Promise.resolve([
        {
          id: 2000,
          encomendaId: 500,
          funcionarioId: 1,
          dataHoraEntrega: agora,
          evidenciaQuemRetirou: '{"recebedorNome":"João Silva"}',
        },
      ]),
      // 5: moradores ativos (para notificação)
      () => Promise.resolve([{ id: 10, nome: "João" }]),
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: () => {
          insertCalls.push({ values: {} })
          return {
            then: (resolve: (v: unknown) => void) =>
              resolve([{ insertId: 2000 }]),
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
    const service = new PainelPortariaService(factory)

    const result = await service.registrarEntrega(
      projeto("taqui", 6611),
      500,
      bodyEntregaBasico,
    )

    expect(result.encomenda.status).toBe("entregue")
    expect(result.entrega.encomendaId).toBe(500)
    expect(result.entrega.funcionarioId).toBe(1)
    // 2 inserts: entrega + notificação de entrega
    expect(insertCalls).toHaveLength(2)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0]?.set.status).toBe("entregue")
  })

  it("entrega sem confirmação (status pendente) → 409 Conflict", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([
        { id: 500, status: "pendente", condominioId: 1, unidadeId: 100 },
      ]),
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }) }) }),
    }

    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("entrega de encomenda já entregue → 409 Conflict", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([
        { id: 500, status: "entregue", condominioId: 1, unidadeId: 100 },
      ]),
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }) }) }),
    }

    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("entrega de encomenda cancelada → 409 Conflict", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([
        { id: 500, status: "cancelada", condominioId: 1, unidadeId: 100 },
      ]),
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }) }) }),
    }

    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("entrega de encomenda de outro condomínio → 404", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([]), // encomenda não encontrada no condomínio
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }) }) }),
    }

    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("entrega sem funcionário válido → 400", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([
        { id: 500, status: "pronta_retirada", condominioId: 1, unidadeId: 100 },
      ]),
      () => Promise.resolve([]), // funcionário não encontrado
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({ values: () => ({ then: (resolve: (v: unknown) => void) => resolve([{ insertId: 1 }]) }) }),
      update: () => ({ set: () => ({ where: () => ({ then: (resolve: (v: unknown) => void) => resolve([1]) }) }) }),
    }

    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe("PainelPortariaService — entrega sem foto (câmera indisponível)", () => {
  it("entrega sem fotoComprovanteUrl é permitida (evidência mínima: recebedorNome)", async () => {
    const insertCalls: Array<{ values: unknown }> = []
    const agora = new Date()

    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve([
        { id: 500, status: "pronta_retirada", condominioId: 1, unidadeId: 100 },
      ]),
      () => Promise.resolve([{ id: 1, nome: "Carlos Portaria" }]),
      () => Promise.resolve([
        {
          id: 2000,
          encomendaId: 500,
          funcionarioId: 1,
          dataHoraEntrega: agora,
          evidenciaQuemRetirou: '{"recebedorNome":"João Silva"}',
        },
      ]),
      () => Promise.resolve([{ id: 10 }]),
    ])

    const db = {
      select: () => fakeChain,
      insert: () => ({
        values: (vals: unknown) => {
          insertCalls.push({ values: vals })
          return {
            then: (resolve: (v: unknown) => void) =>
              resolve([{ insertId: 2000 }]),
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
    const service = new PainelPortariaService(factory)

    // Body sem fotoComprovanteUrl — câmera indisponível
    const bodySemFoto: EntregaBody = {
      funcionarioId: 1,
      recebedorNome: "João Silva",
    }

    const result = await service.registrarEntrega(
      projeto("taqui", 6611),
      500,
      bodySemFoto,
    )

    expect(result.encomenda.status).toBe("entregue")
    // 2 inserts: entrega + notificação de entrega
    expect(insertCalls).toHaveLength(2)
    // A evidência JSON deve conter recebedorNome mesmo sem foto
    const evidencia = (insertCalls[0]?.values as Record<string, unknown>)
      ?.evidenciaQuemRetirou as string
    expect(evidencia).toContain("João Silva")
  })
})

describe("PainelPortariaService — indicadores", () => {
  it("indicadores refletem estado das encomendas do condomínio", async () => {
    const encomendasMock = [
      { status: "pendente", createdAt: new Date(), entregueEm: null },
      { status: "pendente", createdAt: new Date(), entregueEm: null },
      { status: "pronta_retirada", createdAt: new Date(), entregueEm: null },
      { status: "entregue", createdAt: new Date(), entregueEm: new Date() },
      { status: "cancelada", createdAt: new Date(), entregueEm: null },
    ]

    const fakeChain = createFakeChain([
      () => Promise.resolve([{ id: 1 }]),
      () => Promise.resolve(encomendasMock),
    ])

    const db = { select: () => fakeChain }
    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    const indicadores = await service.obterIndicadores(projeto("taqui", 6611))

    expect(indicadores.chegadasHoje).toBe(5)
    expect(indicadores.aguardandoConfirmacao).toBe(2)
    expect(indicadores.prontasParaRetirada).toBe(1)
    expect(indicadores.entreguesHoje).toBe(1)
    expect(indicadores.pendenciasAntigas).toBe(0) // todas criadas hoje
  })
})

describe("PainelPortariaService — isolamento multi-tenant", () => {
  it("database ausente → 404", async () => {
    const factory = makeMockFactory({})
    factory.obter.mockRejectedValue({ code: "ER_BAD_DB_ERROR" })

    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("condomínio inativo → 404", async () => {
    const fakeChain = createFakeChain([
      () => Promise.resolve([]), // sem condomínio ativo
    ])

    const db = { select: () => fakeChain }
    const factory = makeMockFactory(db)
    const service = new PainelPortariaService(factory)

    await expect(
      service.registrarEntrega(projeto("taqui", 6611), 500, bodyEntregaBasico),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
