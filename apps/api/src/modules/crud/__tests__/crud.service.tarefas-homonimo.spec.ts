// @vitest-environment node
/**
 * Resource "tarefas" é homônimo entre projetos: as tarefas do Motor
 * (gerenteagentes — com projeto_id/external_id/tarefa_dependencias) e tabelas
 * de negócio de outros projetos (ex.: gestao-de-tarefas-global). O CRUD
 * genérico não pode aplicar o fluxo exclusivo do Motor (exigir projeto_id,
 * preencher external_id, anexar dependências, reconciliar) a tabelas homônimas
 * de negócio — e precisa manter o comportamento do Motor intacto.
 */
import { describe, expect, it, vi } from "vitest"
import { getTableName } from "drizzle-orm"
import { bigint, mysqlTable, text, varchar } from "drizzle-orm/mysql-core"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { ConfigService } from "@nestjs/config"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { tarefas as tarefasGerente } from "../../../../../../projects/gerenteagentes/schema"
import { CrudService } from "../crud.service"
import type { ProjectDbFactory } from "../project-db.factory"
import type { SchemaRegistry } from "../schema-registry"

/** Tabela de negócio homônima SEM projeto_id/external_id (padrão gestao-de-tarefas-global). */
const tarefasNegocio = mysqlTable("tarefas", {
  id: bigint("id", { mode: "number", unsigned: true })
    .primaryKey()
    .autoincrement(),
  organizacaoId: bigint("organizacao_id", { mode: "number", unsigned: true }).notNull(),
  titulo: varchar("titulo", { length: 200 }).notNull(),
  descricao: text("descricao"),
})

function projeto(slug: string, id: number): ProjetoResumo {
  return { id, nome: slug, slug, perfil: "admin" }
}

function dbFake(linhasPorTabela: Record<string, Array<Record<string, unknown>>> = {}) {
  const tabelasConsultadas: string[] = []
  const execute = vi.fn(async () => [])
  const db = {
    select: () => ({
      from: (tabela: MySqlTable) => {
        tabelasConsultadas.push(getTableName(tabela))
        const resultado = linhasPorTabela[getTableName(tabela)] ?? []
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
    insert: () => ({
      values: async () => [{ insertId: 7 }],
    }),
    update: () => ({
      set: () => ({
        where: async () => [{ affectedRows: 1 }],
      }),
    }),
    delete: () => ({
      where: async () => [{ affectedRows: 1 }],
    }),
    execute,
  }
  return { db, tabelasConsultadas, execute }
}

function montarService(slugDoProjeto: string, fake: ReturnType<typeof dbFake>) {
  const registry: SchemaRegistry = {
    tabelasDoProjeto(slug: string) {
      if (slug === "negocio-gtg") return { tarefas: tarefasNegocio }
      if (slug === "gerenteagentes") return { tarefas: tarefasGerente }
      return undefined
    },
    projetosCarregados() {
      return ["negocio-gtg", "gerenteagentes"]
    },
  }
  const factory = { obter: async () => fake.db } as unknown as ProjectDbFactory
  const configService = { get: () => undefined } as unknown as ConfigService
  return new CrudService(registry, factory, configService)
}

describe('CrudService — resource "tarefas" homônimo (negócio vs Motor)', () => {
  it("criar tarefa de NEGÓCIO não exige projeto_id nem preenche external_id", async () => {
    const fake = dbFake({ tarefas: [{ id: 7, organizacao_id: 1, titulo: "Tarefa GTG" }] })
    const service = montarService("negocio-gtg", fake)

    const linha = await service.criar(projeto("negocio-gtg", 8496), "tarefas", {
      organizacao_id: 1,
      titulo: "Tarefa GTG",
    })

    expect(linha.id).toBe(7)
    // Sem UPDATE de external_id (fluxo exclusivo do Motor).
    expect(fake.execute).not.toHaveBeenCalled()
    // Sem consulta a tarefa_dependencias.
    expect(fake.tabelasConsultadas).not.toContain("tarefa_dependencias")
  })

  it("listar tarefas de NEGÓCIO não consulta tarefa_dependencias", async () => {
    const fake = dbFake({ tarefas: [{ id: 1, titulo: "A" }] })
    const service = montarService("negocio-gtg", fake)

    const resultado = await service.listar(projeto("negocio-gtg", 8496), "tarefas", { filters: {} })

    expect(resultado.items).toHaveLength(1)
    expect(fake.tabelasConsultadas).toContain("tarefas")
    expect(fake.tabelasConsultadas).not.toContain("tarefa_dependencias")
  })

  it("criar tarefa do MOTOR continua exigindo projeto_id (regressão)", async () => {
    const fake = dbFake({ tarefas: [] })
    const service = montarService("gerenteagentes", fake)

    let erro: unknown
    try {
      await service.criar(projeto("gerenteagentes", 640), "tarefas", { titulo: "sem projeto" })
    } catch (capturado) {
      erro = capturado
    }
    const corpo = (erro as { getResponse?: () => unknown })?.getResponse?.() ?? String(erro)
    expect(JSON.stringify(corpo)).toMatch(/projeto_id/)
  })

  it("listar tarefas do MOTOR continua anexando dependências (regressão)", async () => {
    const fake = dbFake({ tarefas: [{ id: 1, titulo: "task" }], tarefa_dependencias: [] })
    const service = montarService("gerenteagentes", fake)

    const resultado = await service.listar(projeto("gerenteagentes", 640), "tarefas", { filters: {} })

    expect(fake.tabelasConsultadas).toContain("tarefa_dependencias")
    expect(resultado.items[0]).toHaveProperty("dependsOnTaskIds")
  })
})
