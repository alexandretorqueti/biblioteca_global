// @vitest-environment node
/**
 * Campos virtuais de pivot N:N no CRUD genérico (macro gestao-de-tarefas,
 * subtarefa config): tabela pivot pura (id + 2 FKs para tabelas diferentes,
 * ex.: tarefa_tags) expõe em cada lado um campo virtual com o nome do
 * resource oposto (ex.: "tags" em tarefas). O create/update sincroniza o
 * pivot; o listar/detalhar anexa os ids. Ausência da chave no body = pivot
 * intocado; array vazio = limpa os vínculos.
 */
import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"
import { getTableName } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { ConfigService } from "@nestjs/config"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { coletarTabelas } from "@biblioteca-global/schema-tools"
import * as gestaoSchema from "../../../../../../projects/gestao-de-tarefas-global/schema"
import { CrudService } from "../crud.service"
import type { ProjectDbFactory } from "../project-db.factory"
import type { SchemaRegistry } from "../schema-registry"

const tabelasGestao = coletarTabelas(gestaoSchema as unknown as Record<string, unknown>)

const PROJETO: ProjetoResumo = {
  id: 8496,
  nome: "Gestão de Tarefas Global",
  slug: "gestao-de-tarefas-global",
  perfil: "admin",
}

interface DbFakeOpcoes {
  linhasPorTabela?: Record<string, Array<Record<string, unknown>>>
  insertId?: number
}

function dbFake(opcoes: DbFakeOpcoes = {}) {
  const linhas = opcoes.linhasPorTabela ?? {}
  const tabelasConsultadas: string[] = []
  const insercoes: Array<{ tabela: string; valores: unknown }> = []
  const exclusoes: string[] = []
  const db = {
    select: () => ({
      from: (tabela: MySqlTable) => {
        tabelasConsultadas.push(getTableName(tabela))
        const resultado = linhas[getTableName(tabela)] ?? []
        return {
          where: () =>
            Object.assign(Promise.resolve(resultado), {
              limit: () =>
                Object.assign(Promise.resolve(resultado), {
                  offset: async () => resultado,
                }),
            }),
        }
      },
    }),
    insert: (tabela: MySqlTable) => ({
      values: async (valores: unknown) => {
        insercoes.push({ tabela: getTableName(tabela), valores })
        return [{ insertId: opcoes.insertId ?? 7 }]
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => [{ affectedRows: 1 }],
      }),
    }),
    delete: (tabela: MySqlTable) => ({
      where: async () => {
        exclusoes.push(getTableName(tabela))
        return [{ affectedRows: 1 }]
      },
    }),
    execute: async () => [],
  }
  return { db, tabelasConsultadas, insercoes, exclusoes }
}

function montarService(fake: ReturnType<typeof dbFake>) {
  const registry: SchemaRegistry = {
    tabelasDoProjeto(slug: string) {
      if (slug === PROJETO.slug) return tabelasGestao
      return undefined
    },
    projetosCarregados() {
      return [PROJETO.slug]
    },
  }
  const factory = { obter: async () => fake.db } as unknown as ProjectDbFactory
  const configService = { get: () => undefined } as unknown as ConfigService
  return new CrudService(registry, factory, configService)
}

/** Corpo mínimo válido de tarefa (colunas notNull sem default). */
const corpoTarefa = {
  organizacao_id: 1,
  titulo: "Tarefa com tags",
  area_id: 2,
  responsavel_id: 3,
  criado_por_id: 3,
}

describe("CrudService — pivot N:N genérico (tarefas ↔ tags via tarefa_tags)", () => {
  it("criar com campo virtual sincroniza o pivot e retorna os ids", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tarefas: [{ id: 7, titulo: "Tarefa com tags" }],
        tags: [{ id: 3 }, { id: 4 }],
        // projeção aliasada do anexarPivots: pai = tarefa_id, oposto = tag_id
        tarefa_tags: [
          { pai: 7, oposto: 3 },
          { pai: 7, oposto: 4 },
        ],
      },
      insertId: 7,
    })
    const service = montarService(fake)

    const linha = await service.criar(PROJETO, "tarefas", {
      ...corpoTarefa,
      tags: [3, 4],
    })

    const insercoesPivot = fake.insercoes.filter((i) => i.tabela === "tarefa_tags")
    expect(insercoesPivot).toHaveLength(1)
    expect(insercoesPivot[0]!.valores).toEqual([
      { tarefaId: 7, tagId: 3 },
      { tarefaId: 7, tagId: 4 },
    ])
    expect(linha.tags).toEqual([3, 4])
  })

  it("criar SEM o campo virtual não toca no pivot", async () => {
    const fake = dbFake({
      linhasPorTabela: { tarefas: [{ id: 7, titulo: "T" }], tags: [] },
      insertId: 7,
    })
    const service = montarService(fake)

    await service.criar(PROJETO, "tarefas", { ...corpoTarefa })

    expect(fake.insercoes.filter((i) => i.tabela === "tarefa_tags")).toHaveLength(0)
    expect(fake.exclusoes).not.toContain("tarefa_tags")
  })

  it("atualizar com array vazio limpa os vínculos", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tarefas: [{ id: 7, titulo: "T" }],
        tags: [{ id: 3 }],
        tarefa_tags: [],
      },
    })
    const service = montarService(fake)

    const linha = await service.atualizar(PROJETO, "tarefas", 7, { tags: [] })

    expect(fake.exclusoes).toContain("tarefa_tags")
    expect(fake.insercoes.filter((i) => i.tabela === "tarefa_tags")).toHaveLength(0)
    expect(linha.tags).toEqual([])
  })

  it("atualizar SOMENTE o campo virtual não falha com 'nenhum campo'", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tarefas: [{ id: 7, titulo: "T" }],
        tags: [{ id: 5 }],
        // projeção aliasada: pai = tarefa_id, oposto = tag_id
        tarefa_tags: [{ pai: 7, oposto: 5 }],
      },
    })
    const service = montarService(fake)

    const linha = await service.atualizar(PROJETO, "tarefas", 7, { tags: [5] })

    expect(linha.tags).toEqual([5])
    expect(fake.insercoes.filter((i) => i.tabela === "tarefa_tags")).toHaveLength(1)
  })

  it("campo virtual que não é array → 400", async () => {
    const fake = dbFake({ linhasPorTabela: { tarefas: [{ id: 7 }], tags: [] } })
    const service = montarService(fake)

    await expect(
      service.criar(PROJETO, "tarefas", { ...corpoTarefa, tags: "3" }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("id inexistente no outro lado → 400 antes de gravar", async () => {
    const fake = dbFake({
      linhasPorTabela: { tarefas: [{ id: 7 }], tags: [{ id: 3 }] },
      insertId: 7,
    })
    const service = montarService(fake)

    await expect(
      service.criar(PROJETO, "tarefas", { ...corpoTarefa, tags: [3, 99] }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(fake.insercoes.filter((i) => i.tabela === "tarefa_tags")).toHaveLength(0)
  })

  it("listar anexa os ids do pivot agrupados por registro", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tarefas: [
          { id: 1, titulo: "A" },
          { id: 2, titulo: "B" },
        ],
        // projeção aliasada do anexarPivots: pai = tarefa_id, oposto = tag_id
        tarefa_tags: [
          { pai: 1, oposto: 3 },
          { pai: 1, oposto: 4 },
          { pai: 2, oposto: 4 },
        ],
      },
    })
    const service = montarService(fake)

    const resultado = await service.listar(PROJETO, "tarefas", { filters: {} })

    expect(resultado.items[0]).toMatchObject({ id: 1, tags: [3, 4] })
    expect(resultado.items[1]).toMatchObject({ id: 2, tags: [4] })
    expect(fake.tabelasConsultadas).toContain("tarefa_tags")
  })

  it("resource do outro lado do pivot também expõe campo virtual", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tags: [{ id: 3, nome: "urgente" }],
        // projeção aliasada: pai = tag_id (lado listado), oposto = tarefa_id
        tarefa_tags: [{ pai: 3, oposto: 1 }],
      },
    })
    const service = montarService(fake)

    const resultado = await service.listar(PROJETO, "tags", { filters: {} })

    expect(resultado.items[0]).toMatchObject({ id: 3, tarefas: [1] })
  })

  it("detalhar anexa o campo virtual", async () => {
    const fake = dbFake({
      linhasPorTabela: {
        tarefas: [{ id: 7, titulo: "T" }],
        // projeção aliasada do anexarPivots: pai = tarefa_id, oposto = tag_id
        tarefa_tags: [{ pai: 7, oposto: 3 }],
      },
    })
    const service = montarService(fake)

    const linha = await service.detalhar(PROJETO, "tarefas", 7)

    expect(linha.tags).toEqual([3])
  })
})
