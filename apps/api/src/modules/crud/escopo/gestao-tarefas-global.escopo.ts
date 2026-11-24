/**
 * Extensão de escopo organizacional do CRUD genérico para o projeto
 * `gestao-de-tarefas-global` (tenancy intra-projeto — macro #2, subtarefa 2).
 *
 * Regras (REQ-F-015, REQ-NF-002):
 * - SELECTs com filtro row-level: `organizacao_id = organização da sessão`;
 *   tabelas sem coluna de organização (tarefa_tags, mensagens_tarefa,
 *   historico_tarefas) são escopadas pelo `tarefa_id` (subconsulta na tabela
 *   tarefas); `organizacoes` só expõe a própria organização da sessão.
 * - Escrita força `organizacao_id` da sessão ignorando o valor do body.
 * - FKs no create/update precisam pertencer à mesma organização
 *   (validação genérica pelas foreign keys do schema Drizzle) → 400 claro.
 * - Leitura/escrita/exclusão de id de outra organização → 404 (a condição de
 *   escopo entra no WHERE do detalhar; registro "não encontrado").
 * - Criação/remoção de organizações é vetada a colaboradores (403): o ciclo
 *   de vida das organizações pertence aos endpoints de administração da
 *   plataforma (subtarefa 3).
 *
 * Registrada em crud.module no token CRUD_ESCOPO_EXTENSIONS — o CrudService
 * só a consulta quando o slug da sessão é `gestao-de-tarefas-global`; o
 * comportamento dos demais projetos permanece intocado.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { and, eq, getTableColumns, getTableName, sql, type Column, type SQL } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/mysql-core"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { CampoPivot } from "@biblioteca-global/schema-tools"
import {
  exigirContextoColaborador,
} from "../../../../../../projects/gestao-de-tarefas-global/src/tenancy/resolvers"
import {
  SemColaboradorAtivoError,
  type ContextoEscopoOrganizacao,
} from "../../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import * as schemaGestao from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type { ProjetoDb } from "../project-db.factory"
import type {
  ContextoEscopoCrud,
  ExtensaoEscopoCrud,
  OperacaoEscopoCrud,
} from "./escopo-crud.extension"

/** Slug do projeto atendido por esta extensão. */
export const SLUG_GESTAO_TAREFAS_GLOBAL = "gestao-de-tarefas-global"

/** Nome da coluna de organização nas tabelas de negócio do projeto. */
const COLUNA_ORGANIZACAO = "organizacao_id"

/** Propriedade Drizzle da coluna de organização (schema do projeto). */
const PROP_ORGANIZACAO = "organizacaoId"

function colunas(tabela: MySqlTable): Record<string, Column> {
  return getTableColumns(tabela) as Record<string, Column>
}

function colunaOrganizacao(tabela: MySqlTable): Column | undefined {
  return Object.values(colunas(tabela)).find(
    (c) => c.name === COLUNA_ORGANIZACAO,
  )
}

function propDaColuna(tabela: MySqlTable, coluna: Column): string | undefined {
  return Object.entries(colunas(tabela)).find(([, c]) => c === coluna)?.[0]
}

/**
 * Escopo organizacional do CRUD genérico para gestao-de-tarefas-global.
 * Sem estado e sem DI: instanciada diretamente no crud.module.
 */
export class GestaoTarefasGlobalEscopo implements ExtensaoEscopoCrud {
  readonly slug = SLUG_GESTAO_TAREFAS_GLOBAL

  contextoDaSessao(escopoOrganizacao: unknown): ContextoEscopoCrud {
    if (!escopoOrganizacao) {
      throw new ForbiddenException(
        "Sessão sem contexto de organização resolvido — acesso negado ao projeto gestao-de-tarefas-global.",
      )
    }
    try {
      const contexto = exigirContextoColaborador(
        escopoOrganizacao as ContextoEscopoOrganizacao,
      )
      return {
        organizacaoId: contexto.organizacaoId,
        colaboradorId: contexto.colaboradorId,
        perfil: contexto.perfil,
      }
    } catch (erro) {
      if (erro instanceof SemColaboradorAtivoError) {
        throw new ForbiddenException(erro.message)
      }
      throw erro
    }
  }

  condicaoLeitura(
    resource: string,
    tabela: MySqlTable,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined {
    void resource
    const nome = getTableName(tabela)
    // A própria organização da sessão é a única linha visível.
    if (nome === getTableName(schemaGestao.organizacoes)) {
      return eq(colunas(tabela).id as never, ctx.organizacaoId as never)
    }
    const org = colunaOrganizacao(tabela)
    if (org) {
      return eq(org as never, ctx.organizacaoId as never)
    }
    // Filhas de tarefa (tarefa_tags, mensagens_tarefa, historico_tarefas):
    // escopo pela tarefa pai pertencer à organização da sessão.
    const tarefaId = Object.values(colunas(tabela)).find(
      (c) => c.name === "tarefa_id",
    )
    if (tarefaId) {
      return sql`${tarefaId} IN (SELECT id FROM ${sql.identifier(
        getTableName(schemaGestao.tarefas),
      )} WHERE organizacao_id = ${ctx.organizacaoId})`
    }
    return undefined
  }

  prepararCorpo(
    tabela: MySqlTable,
    corpo: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): void {
    if (!colunaOrganizacao(tabela)) return
    if (operacao === "create") {
      // Criação sempre pertence à organização da sessão — body é ignorado.
      corpo[COLUNA_ORGANIZACAO] = ctx.organizacaoId
      return
    }
    // Update: sobrescreve apenas se o campo veio no body (parcial).
    if (COLUNA_ORGANIZACAO in corpo) {
      corpo[COLUNA_ORGANIZACAO] = ctx.organizacaoId
    }
  }

  async validarEscrita(
    db: ProjetoDb,
    tabela: MySqlTable,
    valores: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): Promise<void> {
    void operacao
    for (const fk of getTableConfig(tabela).foreignKeys) {
      const { columns, foreignColumns, foreignTable } = fk.reference()
      const local = columns[0]
      const destino = foreignColumns[0]
      if (!local || !destino) continue
      const prop = propDaColuna(tabela, local)
      if (!prop) continue
      const bruto = valores[prop]
      if (bruto === undefined || bruto === null) continue
      const valor = Number(bruto)
      if (!Number.isSafeInteger(valor) || valor <= 0) {
        throw new BadRequestException(
          `Campo "${local.name}": valor inválido — esperado um id positivo.`,
        )
      }
      // FK para a própria tabela de organizações: só a organização da sessão.
      if (getTableName(foreignTable) === getTableName(schemaGestao.organizacoes)) {
        if (valor !== ctx.organizacaoId) {
          throw new BadRequestException(
            `Campo "${local.name}": a organização informada não corresponde à organização da sessão.`,
          )
        }
        continue
      }
      const orgDestino = colunaOrganizacao(foreignTable)
      if (!orgDestino) continue
      const linhas = await db
        .select({ id: destino as never })
        .from(foreignTable)
        .where(
          and(
            eq(destino as never, valor as never),
            eq(orgDestino as never, ctx.organizacaoId as never),
          ),
        )
        .limit(1)
      if ((linhas as Array<Record<string, unknown>>).length === 0) {
        throw new BadRequestException(
          `Campo "${local.name}": o registro referenciado não existe ou pertence a outra organização.`,
        )
      }
    }
  }

  operacaoBloqueada(
    resource: string,
    operacao: OperacaoEscopoCrud,
  ): string | undefined {
    if (
      resource === getTableName(schemaGestao.organizacoes) &&
      (operacao === "create" || operacao === "delete")
    ) {
      return (
        "Criação e remoção de organizações são administradas pelos endpoints " +
        "de administração da plataforma — colaboradores não criam/removem " +
        "organizações pelo CRUD."
      )
    }
    return undefined
  }

  condicaoPivotOposto(
    campo: CampoPivot,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined {
    const org = colunaOrganizacao(campo.tabelaOposta)
    if (!org) return undefined
    return eq(org as never, ctx.organizacaoId as never)
  }
}

/** Prop Drizzle da coluna de organização (reexportado para testes/consumidores). */
export { PROP_ORGANIZACAO }
