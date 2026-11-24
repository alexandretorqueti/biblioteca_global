/**
 * Mecanismo de extensão por projeto do CRUD genérico (tenancy intra-projeto).
 *
 * O CRUD genérico atende todos os projetos; regras de escopo de dados
 * específicas (ex.: filtro row-level por organização no
 * gestao-de-tarefas-global) NÃO podem viver espalhadas no CrudService nem
 * afetar outros slugs. Cada projeto que precisa de regras próprias registra
 * uma `ExtensaoEscopoCrud` no token `CRUD_ESCOPO_EXTENSIONS` (providers do
 * crud.module). O CrudService consulta a extensão pelo slug da sessão:
 * sem extensão registrada → comportamento 100% inalterado.
 *
 * Contratos:
 * - `contextoDaSessao`: traduz o escopo de organização resolvido pelo guard
 *   (req.escopoOrganizacao) no contexto de negócio; lança Forbidden quando a
 *   sessão não pode operar dados do projeto.
 * - `condicaoLeitura`: condição SQL extra aplicada a listar/detalhar
 *   (undefined = sem restrição adicional). Leitura de registro fora do
 *   escopo responde como não encontrada (404) pela ausência natural da linha.
 * - `prepararCorpo`: mutação do corpo (chaves snake_case, pré-Zod) antes da
 *   validação — escrita força o valor de escopo da sessão ignorando o body.
 * - `validarEscrita`: validação de consistência pós-Zod (chaves = props do
 *   Drizzle) com o banco aberto — FKs precisam pertencer ao mesmo escopo.
 * - `operacaoBloqueada`: operações integralmente vetadas para colaboradores
 *   (retorna o motivo → 403).
 * - `condicaoPivotOposto`: escopo da checagem de existência do lado oposto
 *   de pivôs N:N (ex.: tags da tarefa precisam ser da mesma organização).
 */
import type { SQL } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { CampoPivot } from "@biblioteca-global/schema-tools"
import type { ProjetoDb } from "../project-db.factory"

/** Contexto de negócio mínimo consumido pelas extensões (já validado). */
export interface ContextoEscopoCrud {
  organizacaoId: number
  colaboradorId: number
  perfil: string
}

export type OperacaoEscopoCrud = "create" | "update" | "delete"

export interface ExtensaoEscopoCrud {
  /** Slug do projeto ao qual a extensão se aplica (1 extensão por slug). */
  readonly slug: string

  /**
   * Traduz o contexto de organização da request (preenchido pelo guard de
   * tenancy) para o contexto de negócio. Lança `ForbiddenException` quando a
   * sessão não tem acesso a dados de negócio (ex.: master da plataforma).
   */
  contextoDaSessao(escopoOrganizacao: unknown): ContextoEscopoCrud

  /** Condição de leitura (listar/detalhar) para o resource; undefined = livre. */
  condicaoLeitura(
    resource: string,
    tabela: MySqlTable,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined

  /**
   * Prepara o corpo da escrita ANTES do Zod (chaves snake_case = nome de
   * coluna): força os campos de escopo da sessão ignorando valores do body.
   * `create` sempre garante o campo de escopo presente; `update` apenas
   * sobrescreve quando o campo veio no body.
   */
  prepararCorpo(
    tabela: MySqlTable,
    corpo: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): void

  /**
   * Valida a escrita com o banco aberto (valores pós-Zod, chaves = props do
   * Drizzle). FKs apontando para fora do escopo → erro claro (400).
   */
  validarEscrita(
    db: ProjetoDb,
    tabela: MySqlTable,
    valores: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): Promise<void>

  /** Motivo do bloqueio total da operação para o resource; undefined = permitida. */
  operacaoBloqueada(
    resource: string,
    operacao: OperacaoEscopoCrud,
  ): string | undefined

  /** Condição de escopo para a checagem de existência do lado oposto de pivot. */
  condicaoPivotOposto(
    campo: CampoPivot,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined
}

/** Token DI da lista de extensões registradas (crud.module). */
export const CRUD_ESCOPO_EXTENSIONS = Symbol("CRUD_ESCOPO_EXTENSIONS")
