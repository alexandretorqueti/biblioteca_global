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
 * - Dados sensíveis de colaboradores (`cpf`, `telefone`, `email` — REQ-F-017,
 *   clarificação 8): perfis operador/visualizador NÃO recebem esses campos em
 *   nenhuma resposta (leitura remove as chaves na serialização) e NÃO os
 *   gravam (create/update rejeitados com 400 claro); admin/gerente leem e
 *   gravam normalmente. A barreira é o backend — independentemente de
 *   hiddenColumns/roleFilter do front.
 * - Edição de tarefa por status (REQ-F-019, subtarefa 5): update em tarefa com
 *   status ≠ 'aberta' é rejeitado com 409 (motivo retornado ao CrudService via
 *   `motivoBloqueioAtualizacao`); `status` nunca é gravável pelo CRUD (corpo
 *   com a chave → 400, transições pertencem à máquina de estados — macro 3).
 *   A criação permanece aberta a qualquer perfil autenticado do escopo: default
 *   'aberta' vem do schema, `organizacao_id` é forçado pela sessão e
 *   `criado_por_id` ausente no body resolve para o colaborador da sessão.
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

/**
 * Campos sensíveis de contato/identidade de colaboradores (REQ-F-017):
 * nomes de coluna = nomes de propriedade do schema (sem divergência de caso).
 */
const CAMPOS_SENSIVEIS = ["cpf", "telefone", "email"] as const

/**
 * Coluna de status da tarefa (nome de coluna = nome de propriedade). Não é
 * gravável pelo CRUD genérico: insertable/editable false na config (front) e
 * rejeição explícita no corpo (backend) — transições só pelo fluxo custom.
 */
const COLUNA_STATUS = "status"

/** Nome da coluna de criação do autor na tabela tarefas. */
const COLUNA_CRIADO_POR = "criado_por_id"

/** Único status cuja edição genérica é permitida (REQ-F-019). */
const STATUS_EDITAVEL = "aberta"

/** Perfis SEM acesso a dados sensíveis (admin/gerente têm acesso total). */
const PERFIS_SEM_SENSIVEIS = new Set(["operador", "visualizador"])

/** Nomes de coluna da tabela (a barreira de campo é genérica por tabela). */
function nomesDeColunas(tabela: MySqlTable): Set<string> {
  return new Set(Object.values(colunas(tabela)).map((c) => c.name))
}

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

/** A tabela é a de tarefas deste projeto (homônimas de outros slugs não chegam aqui). */
function ehTabelaTarefas(tabela: MySqlTable): boolean {
  return getTableName(tabela) === getTableName(schemaGestao.tarefas)
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
    // Regra de status da tarefa (REQ-F-019, subtarefa 5): a chave `status`
    // nunca é gravável pelo CRUD genérico — create/update com a chave no
    // corpo são recusados com erro claro (a máquina de estados de delegação/
    // devolução pertence ao fluxo custom). Vale para qualquer perfil.
    if (ehTabelaTarefas(tabela) && COLUNA_STATUS in corpo) {
      throw new BadRequestException(
        `O campo "status" não é editável pelo CRUD de tarefas — as transições de status pertencem ao fluxo da tarefa.`,
      )
    }
    // Criação de tarefa é aberta a qualquer perfil do escopo: autor ausente
    // no body resolve para o colaborador da sessão (o default do schema é
    // status "aberta"; organizacao_id é forçado logo abaixo).
    if (
      operacao === "create" &&
      ehTabelaTarefas(tabela) &&
      corpo[COLUNA_CRIADO_POR] === undefined
    ) {
      corpo[COLUNA_CRIADO_POR] = ctx.colaboradorId
    }
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

  /**
   * Criação de tarefa é aberta a QUALQUER perfil autenticado no escopo da
   * organização (inclui operador/visualizador — critério "qualquer usuário
   * cria tarefa"). Demais resources mantêm a regra padrão da plataforma.
   */
  perfilPodeCriar(resource: string, perfil: string): boolean {
    void perfil
    return resource === getTableName(schemaGestao.tarefas)
  }

  /**
   * Edição genérica de tarefa somente com status 'aberta' (REQ-F-019,
   * subtarefa 5). Tarefa em outro status responde 409 com mensagem clara —
   * a evolução do registro pertence à máquina de estados (fluxo custom).
   * Independe de perfil (admin incluído) e de resource de outro domínio.
   */
  motivoBloqueioAtualizacao(
    resource: string,
    tabela: MySqlTable,
    linhaAtual: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
  ): string | undefined {
    void resource
    void ctx
    if (!ehTabelaTarefas(tabela)) return undefined
    const status = linhaAtual[COLUNA_STATUS]
    if (typeof status === "string" && status !== STATUS_EDITAVEL) {
      return `edição indisponível: tarefa com status "${status}" só evolui pelo fluxo da tarefa`
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

  /**
   * Barreira de LEITURA: operador/visualizador não recebem `cpf`, `telefone`
   * nem `email` em nenhuma resposta do CRUD (as chaves saem removidas da
   * linha serializada pelo CrudService). Admin/gerente: lista vazia —
   * comportamento normal de leitura.
   */
  camposSensiveisNaLeitura(
    resource: string,
    tabela: MySqlTable,
    ctx: ContextoEscopoCrud,
  ): string[] {
    void resource
    if (!PERFIS_SEM_SENSIVEIS.has(ctx.perfil)) return []
    const nomes = nomesDeColunas(tabela)
    return CAMPOS_SENSIVEIS.filter((campo) => nomes.has(campo))
  }

  /**
   * Barreira de ESCRITA: operador/visualizador não gravam `cpf`, `telefone`
   * nem `email` (create/update) — 400 claro nomeando os campos. A ausência do
   * campo no body é neutra (update parcial continua permitido ao perfil).
   */
  rejeitarEscritaDeCamposSensiveis(
    tabela: MySqlTable,
    corpo: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): void {
    if (!PERFIS_SEM_SENSIVEIS.has(ctx.perfil)) return
    const nomes = nomesDeColunas(tabela)
    const enviados = CAMPOS_SENSIVEIS.filter(
      (campo) => nomes.has(campo) && campo in corpo,
    )
    if (enviados.length === 0) return
    throw new BadRequestException(
      `Dados sensíveis de colaboradores (${enviados.join(", ")}) são visíveis e graváveis apenas por admin e gerente — ` +
        `o perfil "${ctx.perfil}" não pode ${operacao === "create" ? "cadastrar" : "alterar"} esses campos.`,
    )
  }
}

/** Prop Drizzle da coluna de organização (reexportado para testes/consumidores). */
export { PROP_ORGANIZACAO }
