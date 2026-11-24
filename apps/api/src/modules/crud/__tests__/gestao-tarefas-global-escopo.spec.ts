// @vitest-environment node
/**
 * Unit tests da extensão de escopo organizacional do CRUD genérico
 * (gestao-de-tarefas-global — macro #2, subtarefa 2).
 *
 * Cobre: tradução do contexto da sessão (colaborador/master/ausente),
 * condição row-level por tabela (com organização, filha de tarefa,
 * organizações), forçar organizacao_id na escrita, validação de FK
 * cross-organization, bloqueio de create/delete de organizações, escopo do
 * lado oposto de pivôs e o wiring no CrudService (sem DB: bloqueios e
 * ausência de contexto são avaliados antes de abrir conexão).
 */
import { describe, expect, it } from "vitest"
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import type { ConfigService } from "@nestjs/config"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { coletarTabelas, camposPivotDoResource } from "@biblioteca-global/schema-tools"
import * as schemaGestao from "../../../../../../projects/gestao-de-tarefas-global/schema"
import { GestaoTarefasGlobalEscopo, SLUG_GESTAO_TAREFAS_GLOBAL } from "../escopo/gestao-tarefas-global.escopo"
import { CRUD_ESCOPO_EXTENSIONS, type ContextoEscopoCrud } from "../escopo/escopo-crud.extension"
import { CrudService } from "../crud.service"
import { RealtimeService } from "../../realtime/realtime.service"
import type { ProjectDbFactory, ProjetoDb } from "../project-db.factory"
import type { SchemaRegistry } from "../schema-registry"
import type { CampoPivot } from "@biblioteca-global/schema-tools"
import type { MySqlTable } from "drizzle-orm/mysql-core"

const tabelas = coletarTabelas(schemaGestao) as Record<string, MySqlTable>
const extensao = new GestaoTarefasGlobalEscopo()
const ctx: ContextoEscopoCrud = { organizacaoId: 10, colaboradorId: 7, perfil: "admin" }
const dialect = new MySqlDialect()

function render(condicao: ReturnType<typeof extensao.condicaoLeitura>): { sql: string; params: unknown[] } {
  if (!condicao) throw new Error("condição ausente")
  const query = dialect.sqlToQuery(condicao)
  return { sql: query.sql, params: query.params as unknown[] }
}

/** Db fake encadeável que devolve linhas programadas e registra as consultas. */
function dbFake(linhas: Array<Record<string, unknown>> = []) {
  const consultas: Array<{ tabela: string }> = []
  const db = {
    select: () => ({
      from: (tabela: MySqlTable) => {
        consultas.push({ tabela: nomeTabela(tabela) })
        return {
          where: () => ({
            limit: async () => linhas,
          }),
        }
      },
    }),
  }
  return { db: db as unknown as ProjetoDb, consultas }
}

function nomeTabela(tabela: MySqlTable): string {
  for (const [nome, t] of Object.entries(tabelas)) {
    if (t === tabela) return nome
  }
  return "?"
}

describe("GestaoTarefasGlobalEscopo — contextoDaSessao", () => {
  it("colaborador → contexto de negócio", () => {
    const resultado = extensao.contextoDaSessao({
      tipo: "colaborador",
      organizacaoId: 10,
      colaboradorId: 7,
      perfil: "gerente",
    })
    expect(resultado).toEqual({ organizacaoId: 10, colaboradorId: 7, perfil: "gerente" })
  })

  it("master da plataforma → 403 (não opera dados de negócio)", () => {
    expect(() => extensao.contextoDaSessao({ tipo: "master", usuarioId: 1 })).toThrow(
      ForbiddenException,
    )
  })

  it("sessão sem contexto resolvido → 403", () => {
    expect(() => extensao.contextoDaSessao(undefined)).toThrow(ForbiddenException)
  })

  it("slug da extensão", () => {
    expect(extensao.slug).toBe(SLUG_GESTAO_TAREFAS_GLOBAL)
  })
})

describe("GestaoTarefasGlobalEscopo — condicaoLeitura (row-level)", () => {
  it("tabelas com organizacao_id → WHERE organizacao_id = sessão", () => {
    for (const recurso of ["colaboradores", "areas", "tags", "regras_recorrencia", "tarefas", "anexos", "notificacoes"]) {
      const { sql, params } = render(extensao.condicaoLeitura(recurso, tabelas[recurso]!, ctx))
      expect(sql).toContain("`organizacao_id` = ?")
      expect(params).toEqual([10])
    }
  })

  it("tabelas filhas de tarefa → WHERE tarefa_id IN (subconsulta por organização)", () => {
    for (const recurso of ["tarefa_tags", "mensagens_tarefa", "historico_tarefas"]) {
      const { sql, params } = render(extensao.condicaoLeitura(recurso, tabelas[recurso]!, ctx))
      expect(sql).toContain("`tarefa_id` IN (SELECT id FROM `tarefas` WHERE organizacao_id = ?)")
      expect(params).toEqual([10])
    }
  })

  it("organizacoes → somente a própria organização (id = sessão)", () => {
    const { sql, params } = render(extensao.condicaoLeitura("organizacoes", tabelas.organizacoes!, ctx))
    expect(sql).toContain("`id` = ?")
    expect(params).toEqual([10])
  })
})

describe("GestaoTarefasGlobalEscopo — prepararCorpo (escrita força a sessão)", () => {
  it("create: força organizacao_id da sessão ignorando o body", () => {
    const corpo: Record<string, unknown> = { nome: "Área X", organizacao_id: 999 }
    extensao.prepararCorpo(tabelas.areas!, corpo, ctx, "create")
    expect(corpo.organizacao_id).toBe(10)
  })

  it("create: adiciona organizacao_id quando ausente no body", () => {
    const corpo: Record<string, unknown> = { nome: "Tag Y" }
    extensao.prepararCorpo(tabelas.tags!, corpo, ctx, "create")
    expect(corpo.organizacao_id).toBe(10)
  })

  it("update: sobrescreve apenas quando o campo veio no body", () => {
    const comOrg: Record<string, unknown> = { organizacao_id: 999 }
    extensao.prepararCorpo(tabelas.tarefas!, comOrg, ctx, "update")
    expect(comOrg.organizacao_id).toBe(10)

    const semOrg: Record<string, unknown> = { titulo: "novo" }
    extensao.prepararCorpo(tabelas.tarefas!, semOrg, ctx, "update")
    expect("organizacao_id" in semOrg).toBe(false)
  })

  it("tabelas sem organizacao_id: corpo intocado", () => {
    const corpo: Record<string, unknown> = { texto: "mensagem" }
    extensao.prepararCorpo(tabelas.mensagens_tarefa!, corpo, ctx, "create")
    expect(corpo).toEqual({ texto: "mensagem" })
  })
})

describe("GestaoTarefasGlobalEscopo — validarEscrita (FK por organização)", () => {
  it("FK de outra organização/inexistente → 400 com mensagem clara", async () => {
    const { db } = dbFake([]) // nenhuma linha encontrada
    await expect(
      extensao.validarEscrita(db, tabelas.tarefas!, { areaId: 55, titulo: "t" }, ctx, "create"),
    ).rejects.toThrow(BadRequestException)
    await expect(
      extensao.validarEscrita(db, tabelas.tarefas!, { areaId: 55 }, ctx, "create"),
    ).rejects.toThrow(/area_id/)
  })

  it("FK da mesma organização → passa", async () => {
    const { db } = dbFake([{ id: 55 }])
    await expect(
      extensao.validarEscrita(
        db,
        tabelas.tarefas!,
        { areaId: 55, responsavelId: 7, criadoPorId: 7 },
        ctx,
        "create",
      ),
    ).resolves.toBeUndefined()
  })

  it("organizacao_id divergente da sessão → 400", async () => {
    const { db } = dbFake([{ id: 1 }])
    await expect(
      extensao.validarEscrita(db, tabelas.areas!, { organizacaoId: 999 }, ctx, "update"),
    ).rejects.toThrow(/organização da sessão/)
  })

  it("valores nulos/ausentes são ignorados (update parcial)", async () => {
    const { db, consultas } = dbFake([])
    await expect(
      extensao.validarEscrita(db, tabelas.tarefas!, { titulo: "sem FK", descricao: null }, ctx, "update"),
    ).resolves.toBeUndefined()
    expect(consultas.length).toBe(0)
  })

  it("FK inválida (não numérica) → 400", async () => {
    const { db } = dbFake([])
    await expect(
      extensao.validarEscrita(db, tabelas.tarefas!, { areaId: "abc" }, ctx, "create"),
    ).rejects.toThrow(BadRequestException)
  })
})

describe("GestaoTarefasGlobalEscopo — operacaoBloqueada e pivôs", () => {
  it("create/delete de organizacoes → bloqueado para colaboradores", () => {
    expect(extensao.operacaoBloqueada("organizacoes", "create")).toBeTruthy()
    expect(extensao.operacaoBloqueada("organizacoes", "delete")).toBeTruthy()
    expect(extensao.operacaoBloqueada("organizacoes", "update")).toBeUndefined()
    expect(extensao.operacaoBloqueada("tarefas", "create")).toBeUndefined()
    expect(extensao.operacaoBloqueada("tarefas", "delete")).toBeUndefined()
  })

  it("pivot tarefas→tags: lado oposto escopado por organização", () => {
    const campos = camposPivotDoResource(tabelas, "tarefas") as CampoPivot[]
    const campoTags = campos.find((c) => c.campo === "tags")
    expect(campoTags).toBeTruthy()
    const { sql, params } = render(extensao.condicaoPivotOposto(campoTags!, ctx))
    expect(sql).toContain("`organizacao_id` = ?")
    expect(params).toEqual([10])
  })
})

describe("CrudService — wiring da extensão de escopo (sem DB)", () => {
  const projetoGestao = { id: 8496, nome: "Gestão", slug: SLUG_GESTAO_TAREFAS_GLOBAL, perfil: "admin" as const }
  const projetoOutro = { id: 640, nome: "Gerente", slug: "gerenteagentes", perfil: "admin" as const }

  function montar() {
    const registry: SchemaRegistry = {
      tabelasDoProjeto: (slug: string) =>
        slug === SLUG_GESTAO_TAREFAS_GLOBAL ? tabelas : undefined,
      projetosCarregados: () => [SLUG_GESTAO_TAREFAS_GLOBAL],
    }
    const factory = {
      obter: async () => {
        throw new Error("database não deveria ser acionado neste teste")
      },
    } as unknown as ProjectDbFactory
    const configService = { get: () => undefined } as unknown as ConfigService
    const service = new CrudService(
      registry,
      factory,
      configService,
      new RealtimeService(),
      [extensao],
    )
    return service
  }

  it("listar sem contexto de organização → 403 antes de abrir conexão", async () => {
    await expect(
      montar().listar(projetoGestao, "tarefas", { filters: {} }, undefined),
    ).rejects.toThrow(ForbiddenException)
  })

  it("listar com contexto master → 403", async () => {
    await expect(
      montar().listar(projetoGestao, "tarefas", { filters: {} }, { tipo: "master", usuarioId: 1 }),
    ).rejects.toThrow(ForbiddenException)
  })

  it("criar organizacoes (colaborador) → 403 antes de abrir conexão", async () => {
    const contexto = { tipo: "colaborador", organizacaoId: 10, colaboradorId: 7, perfil: "admin" }
    await expect(
      montar().criar(projetoGestao, "organizacoes", { nome: "Org X" }, contexto),
    ).rejects.toThrow(ForbiddenException)
  })

  it("remover organizacoes (colaborador) → 403 antes de abrir conexão", async () => {
    const contexto = { tipo: "colaborador", organizacaoId: 10, colaboradorId: 7, perfil: "admin" }
    await expect(
      montar().remover(projetoGestao, "organizacoes", 10, contexto),
    ).rejects.toThrow(ForbiddenException)
  })

  it("projetos sem extensão permanecem inalterados (sem 403 de tenancy)", async () => {
    // Sem extensão para o slug → nenhum contexto é exigido; a falha vem só
    // da whitelist (404), provando que o hook é condicionado ao slug.
    await expect(
      montar().listar(projetoOutro, "tarefas", { filters: {} }, undefined),
    ).rejects.toThrow(NotFoundException)
  })

  it("CRUD_ESCOPO_EXTENSIONS é um symbol estável", () => {
    expect(typeof CRUD_ESCOPO_EXTENSIONS).toBe("symbol")
  })
})
