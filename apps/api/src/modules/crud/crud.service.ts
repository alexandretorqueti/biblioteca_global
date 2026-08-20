/**
 * CrudService — CRUD genérico por resource no DATABASE DO PROJETO DO TOKEN
 * (PoC §6.2). Regras:
 * - Whitelist derivada do schema.ts do projeto da sessão (resource fora → 404).
 * - Resources reservados (core) nunca passam pelo CRUD genérico.
 * - Validação Zod derivada do Drizzle: inválido → 400; duplicado → 409.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, getTableColumns, sql, type Column } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { PaginatedResult, ProjetoResumo } from "@biblioteca-global/shared"
import {
  ehErroDatabaseAusente,
  ehErroDuplicado,
} from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "./project-db.factory"
import { SCHEMA_REGISTRY, type SchemaRegistry } from "./schema-registry"
import { zodParaInsert, zodParaUpdate } from "@biblioteca-global/schema-tools"

/** Nomes que pertencem ao core/módulos específicos — nunca genéricos. */
export const RESOURCES_RESERVADOS: ReadonlySet<string> = new Set([
  "auth",
  "usuarios",
  "projetos",
  "projetos_usuarios",
  "refresh_tokens",
])

export interface CrudListParams {
  page?: number
  pageSize?: number
  /** Filtros por coluna (valores de query string). */
  filters: Record<string, string>
}

@Injectable()
export class CrudService {
  private readonly schemas = new Map<
    string,
    { insert: ReturnType<typeof zodParaInsert>; update: ReturnType<typeof zodParaUpdate> }
  >()

  constructor(
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  /** Resolve a tabela na whitelist do projeto; 404 fora dela. */
  resolverTabela(projeto: ProjetoResumo, resource: string): MySqlTable {
    if (RESOURCES_RESERVADOS.has(resource)) {
      throw new NotFoundException("Resource não encontrado")
    }
    const tabelas = this.registry.tabelasDoProjeto(projeto.slug)
    const tabela = tabelas?.[resource]
    if (!tabela) {
      throw new NotFoundException("Resource não encontrado")
    }
    return tabela
  }

  private schemasDe(projeto: ProjetoResumo, resource: string) {
    const chave = `${projeto.slug}:${resource}`
    let par = this.schemas.get(chave)
    if (!par) {
      const tabela = this.resolverTabela(projeto, resource)
      par = { insert: zodParaInsert(tabela), update: zodParaUpdate(tabela) }
      this.schemas.set(chave, par)
    }
    return par
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    try {
      return await this.factory.obter({ id: projeto.id })
    } catch (erro: unknown) {
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  private colunaDaTabela(tabela: MySqlTable, nome: string): Column {
    const coluna = getTableColumns(tabela)[nome]
    if (!coluna) {
      throw new BadRequestException(`Coluna desconhecida: ${nome}`)
    }
    return coluna as unknown as Column
  }

  private valorParaColuna(coluna: Column, valor: string): unknown {
    switch (coluna.dataType) {
      case "number":
      case "bigint": {
        const numero = Number(valor)
        if (Number.isNaN(numero)) {
          throw new BadRequestException(
            `Valor numérico inválido para ${coluna.name}`,
          )
        }
        return numero
      }
      case "boolean":
        return valor === "true" || valor === "1"
      default:
        return valor
    }
  }

  private colunaId(tabela: MySqlTable): Column {
    return this.colunaDaTabela(tabela, "id")
  }

  async listar(
    projeto: ProjetoResumo,
    resource: string,
    params: CrudListParams,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const tabela = this.resolverTabela(projeto, resource)

    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 20
    if (page < 1 || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException("Paginação inválida")
    }

    // Valida filtros contra a tabela ANTES de abrir conexão.
    const condicoes = Object.entries(params.filters).map(([nome, valor]) => {
      const coluna = this.colunaDaTabela(tabela, nome)
      return eq(coluna as never, this.valorParaColuna(coluna, valor) as never)
    })
    const onde = condicoes.length > 0 ? and(...condicoes) : undefined

    const db = await this.dbDoProjeto(projeto)
    try {
      const total = await db
        .select({ quantidade: sql<number>`count(*)` })
        .from(tabela)
        .where(onde)
      const items = await db
        .select()
        .from(tabela)
        .where(onde)
        .limit(pageSize)
        .offset((page - 1) * pageSize)

      return {
        items: items as Record<string, unknown>[],
        total: Number(total.at(0)?.quantidade ?? 0),
        page,
        pageSize,
      }
    } catch (erro: unknown) {
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  async detalhar(
    projeto: ProjetoResumo,
    resource: string,
    id: number,
  ): Promise<Record<string, unknown>> {
    const tabela = this.resolverTabela(projeto, resource)
    const db = await this.dbDoProjeto(projeto)
    const linhas = await db
      .select()
      .from(tabela)
      .where(eq(this.colunaId(tabela) as never, id as never))
      .limit(1)
    const linha = linhas.at(0)
    if (!linha) {
      throw new NotFoundException("Registro não encontrado")
    }
    return linha as Record<string, unknown>
  }

  /**
   * Converte chaves snake_case (coluna.name, contrato do formulário) para as
   * propriedades TS do schema (camelCase) que o drizzle aceita em values/set.
   * O zodParaInsert valida pelo nome da coluna; o drizzle espera a propriedade
   * (chaves não reconhecidas são ignoradas silenciosamente → default → 1364).
   */
  private paraChavesDoDrizzle(
    tabela: MySqlTable,
    dados: Record<string, unknown>,
  ): Record<string, unknown> {
    const colunas = getTableColumns(tabela)
    const mapa = new Map<string, string>()
    for (const [prop, coluna] of Object.entries(colunas)) {
      mapa.set(coluna.name, prop)
    }
    const saida: Record<string, unknown> = {}
    for (const [chave, valor] of Object.entries(dados)) {
      const prop = mapa.get(chave)
      saida[prop ?? chave] = valor
    }
    return saida
  }

  /**
   * Converte chaves camelCase (propriedades TS do schema, contrato do
   * formulário web) para snake_case (coluna.name, contrato do zod/API).
   * Chaves que já estão em snake_case (API direta) passam intactas;
   * chaves inexistentes permanecem e o zod strict rejeita.
   */
  private normalizarChaves(
    tabela: MySqlTable,
    dados: unknown,
  ): Record<string, unknown> {
    // Corpo não-objeto (null, array, primitivo) segue para o zod rejeitar.
    if (typeof dados !== "object" || dados === null || Array.isArray(dados)) {
      return dados as Record<string, unknown>
    }
    const colunas = getTableColumns(tabela)
    const porProp = new Map<string, string>()
    for (const [prop, coluna] of Object.entries(colunas)) {
      porProp.set(prop, coluna.name)
    }
    const saida: Record<string, unknown> = {}
    for (const [chave, valor] of Object.entries(dados)) {
      saida[porProp.get(chave) ?? chave] = valor
    }
    return saida
  }

  async criar(
    projeto: ProjetoResumo,
    resource: string,
    corpo: unknown,
  ): Promise<Record<string, unknown>> {
    const tabela = this.resolverTabela(projeto, resource)
    const { insert } = this.schemasDe(projeto, resource)
    const parse = insert.safeParse(this.normalizarChaves(tabela, corpo))
    if (!parse.success) {
      throw new BadRequestException({
        message: "Registro inválido",
        details: parse.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }

    const db = await this.dbDoProjeto(projeto)
    try {
      const resultado = await db
        .insert(tabela)
        .values(this.paraChavesDoDrizzle(tabela, parse.data as Record<string, unknown>))
      const insertId = resultado[0].insertId
      return this.detalhar(projeto, resource, insertId)
    } catch (erro: unknown) {
      if (ehErroDuplicado(erro)) {
        throw new ConflictException("Registro duplicado")
      }
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  async atualizar(
    projeto: ProjetoResumo,
    resource: string,
    id: number,
    corpo: unknown,
  ): Promise<Record<string, unknown>> {
    const tabela = this.resolverTabela(projeto, resource)
    const { update } = this.schemasDe(projeto, resource)
    const parse = update.safeParse(this.normalizarChaves(tabela, corpo))
    if (!parse.success) {
      throw new BadRequestException({
        message: "Registro inválido",
        details: parse.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    const campos = this.paraChavesDoDrizzle(
      tabela,
      parse.data as Record<string, unknown>,
    )
    if (Object.keys(campos).length === 0) {
      throw new BadRequestException("Nenhum campo para atualizar")
    }

    // Existe? (404 antes de atualizar)
    await this.detalhar(projeto, resource, id)

    const db = await this.dbDoProjeto(projeto)
    try {
      await db
        .update(tabela)
        .set(campos)
        .where(eq(this.colunaId(tabela) as never, id as never))
      return this.detalhar(projeto, resource, id)
    } catch (erro: unknown) {
      if (ehErroDuplicado(erro)) {
        throw new ConflictException("Registro duplicado")
      }
      throw erro
    }
  }

  async remover(
    projeto: ProjetoResumo,
    resource: string,
    id: number,
  ): Promise<void> {
    const tabela = this.resolverTabela(projeto, resource)
    const db = await this.dbDoProjeto(projeto)
    const resultado = await db
      .delete(tabela)
      .where(eq(this.colunaId(tabela) as never, id as never))
    if (resultado[0].affectedRows === 0) {
      throw new NotFoundException("Registro não encontrado")
    }
  }
}
