/**
 * CrudService — CRUD genérico por resource no DATABASE DO PROJETO DO TOKEN
 * (PoC §6.2). Regras:
 * - Whitelist derivada do schema.ts do projeto da sessão (resource fora → 404).
 * - Resources reservados (core) nunca passam pelo CRUD genérico.
 * - Validação Zod derivada do Drizzle: inválido → 400; duplicado → 409.
 *
 * Recursos virtuais (fora do banco, servidos no back):
 * - `__openclaw_agentes__` — agentes reais do OpenClaw (fonte: Console
 *   OpenClaw `GET /api/agents`). O ID retornado é o ID estável do console.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { and, asc, desc, eq, getTableColumns, like, or, sql, type Column } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { CrudOrderByItem, PaginatedResult, ProjetoResumo } from "@biblioteca-global/shared"
import { request as httpNodeRequest } from "node:http"
import { request as httpsNodeRequest } from "node:https"
import {
  ehErroDatabaseAusente,
  ehErroDuplicado,
} from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "./project-db.factory"
import { SCHEMA_REGISTRY, type SchemaRegistry } from "./schema-registry"
import { zodParaInsert, zodParaUpdate } from "@biblioteca-global/schema-tools"
import { projetosCaptados } from "../../../../../projects/gerenteagentes/schema"

/** Nomes que pertencem ao core/módulos específicos — nunca genéricos. */
export const RESOURCES_RESERVADOS: ReadonlySet<string> = new Set([
  "auth",
  "usuarios",
  "projetos",
  "projetos_usuarios",
  "refresh_tokens",
])

/** Limite máximo de valores no valuesLast de um orderBy. */
export const ORDER_BY_VALUES_LAST_MAX = 20

/**
 * Virtual resource do CRUD genérico: lista os agentes reais do OpenClaw.
 * Os agentes não são persistidos neste projeto; POST/PUT/DELETE não aplicam.
 */
export const VIRTUAL_RESOURCE_OPENCLAW_AGENTES = "__openclaw_agentes__"

export interface CrudListParams {
  page?: number
  pageSize?: number
  /** Busca textual: OR LIKE case-insensível nas colunas de texto (text/varchar). */
  search?: string
  /** Filtros por coluna (valores de query string). */
  filters: Record<string, string>
  /** Ordenação por colunas (validada contra a tabela). */
  orderBy?: CrudOrderByItem[]
}

@Injectable()
export class CrudService {
  private readonly schemas = new Map<
    string,
    { insert: ReturnType<typeof zodParaInsert>; update: ReturnType<typeof zodParaUpdate> }
  >()

  // ── Virtual resource: agentes do OpenClaw (Console OpenClaw) ─────────────
  private readonly consoleUrl: string
  private readonly consoleToken: string
  private consoleAgentesCache: { at: number; agents: Record<string, unknown>[] } | null = null
  private static readonly CONSOLE_CACHE_TTL_MS = 60_000

  constructor(
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {
    this.consoleUrl =
      this.configService.get<string>("OPENCLAW_CONSOLE_URL") ||
      "https://openclaw-api.webconnect.com.br"
    this.consoleToken = (this.configService.get<string>("OPENCLAW_CONSOLE_TOKEN") || "").trim()
  }

  /** Resolve a tabela na whitelist do projeto; 404 fora dela. */
  resolverTabela(projeto: ProjetoResumo, resource: string): MySqlTable {
    if (resource === VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new Error("resolverTabela não suporta recursos virtuais")
    }
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

  // ============================================================================
  // Virtual resource: agentes do OpenClaw
  // ============================================================================

  /**
   * Consulta os agentes do Console OpenClaw com cache de 60 s (a lista é
   * pequena e muda raramente; o TTL evita martelar o console a cada
   * abertura do formulário). Falha de rede → 503 legível, sem cache.
   */
  private async agentesDoConsole(): Promise<Record<string, unknown>[]> {
    if (
      this.consoleAgentesCache &&
      Date.now() - this.consoleAgentesCache.at < CrudService.CONSOLE_CACHE_TTL_MS
    ) {
      return this.consoleAgentesCache.agents
    }
    const url = new URL(`${this.consoleUrl}/api/agents`)
    const isHttps = url.protocol === "https:"
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(this.consoleToken ? { Authorization: `Bearer ${this.consoleToken}` } : {}),
      },
      timeout: 10_000,
    }
    const body = await new Promise<string>((resolve, reject) => {
      const req = (isHttps ? httpsNodeRequest : httpNodeRequest)(options, (res) => {
        let dados = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (dados += chunk))
        res.on("end", () => resolve(dados))
      })
      req.on("timeout", () => req.destroy(new Error("timeout")))
      req.on("error", reject)
      req.end()
    }).catch((erro: unknown) => {
      throw new BadRequestException(
        `Console OpenClaw indisponível: ${erro instanceof Error ? erro.message : String(erro)}`,
      )
    })
    let parsed: { agents?: Array<Record<string, unknown>> }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new BadRequestException("Console OpenClaw: resposta inválida")
    }
    const agents = Array.isArray(parsed.agents) ? parsed.agents : []
    this.consoleAgentesCache = { at: Date.now(), agents }
    return agents
  }

  private async listarAgentesMesclados(
    _projeto: ProjetoResumo,
    search?: string,
  ): Promise<Record<string, unknown>[]> {
    const consoleAgents = await this.agentesDoConsole()
    const rows = consoleAgents
      .filter((agent) => String(agent.id ?? ""))
      .map((agent) => ({
        id: String(agent.id),
        name: String(agent.name ?? agent.id),
        model: agent.model,
        status: agent.status,
      }))
    const termo = search?.trim().toLowerCase()
    if (!termo) return rows
    return rows.filter(
      (r) =>
        String(r.name).toLowerCase().includes(termo) ||
        String(r.id).toLowerCase().includes(termo) ||
        String(r.model ?? "").toLowerCase().includes(termo),
    )
  }

  async listarVirtual(
    projeto: ProjetoResumo,
    resource: string,
    params: CrudListParams,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    if (resource !== VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new NotFoundException("Resource não encontrado")
    }
    const page = params.page ?? 1
    const pageSize = Math.min(params.pageSize ?? 100, 100)
    if (page < 1 || pageSize < 1) {
      throw new BadRequestException("Paginação inválida")
    }
    const todos = await this.listarAgentesMesclados(projeto, params.search)
    const start = (page - 1) * pageSize
    return {
      items: todos.slice(start, start + pageSize),
      total: todos.length,
      page,
      pageSize,
    }
  }

  async detalharVirtual(
    projeto: ProjetoResumo,
    resource: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    if (resource !== VIRTUAL_RESOURCE_OPENCLAW_AGENTES) {
      throw new NotFoundException("Resource não encontrado")
    }
    const rows = await this.listarAgentesMesclados(projeto)
    const linha = rows.find((r) => String(r.id) === id)
    if (!linha) {
      throw new NotFoundException("Registro não encontrado")
    }
    return linha
  }

  // ============================================================================
  // CRUD genérico (banco do projeto)
  // ============================================================================

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

  /**
   * Valida valuesLast contra a coluna: máximo de itens e compatibilidade
   * de tipo. Colunas numéricas exigem valores convertíveis para número;
   * colunas booleanas exigem 0/1/true/false; colunas string aceitam
   * qualquer string. Retorna os valores normalizados para o tipo da coluna.
   */
  private validarValuesLast(
    coluna: Column,
    valuesLast: (string | number)[],
    campo: string,
  ): (string | number)[] {
    if (valuesLast.length > ORDER_BY_VALUES_LAST_MAX) {
      throw new BadRequestException(
        `valuesLast de "${campo}" excede o máximo de ${ORDER_BY_VALUES_LAST_MAX} itens`,
      )
    }
    if (valuesLast.length === 0) return valuesLast

    const tipo = coluna.dataType
    if (tipo === "number" || tipo === "bigint") {
      for (const v of valuesLast) {
        if (typeof v === "string" && Number.isNaN(Number(v))) {
          throw new BadRequestException(
            `valuesLast de "${campo}": valor "${v}" incompatível com coluna numérica`,
          )
        }
      }
      return valuesLast.map((v) => (typeof v === "string" ? Number(v) : v))
    }
    if (tipo === "boolean") {
      const validos = new Set(["0", "1", "true", "false", 0, 1])
      for (const v of valuesLast) {
        if (!validos.has(v)) {
          throw new BadRequestException(
            `valuesLast de "${campo}": valor "${String(v)}" incompatível com coluna booleana`,
          )
        }
      }
    }
    // string e outros tipos: aceita qualquer valor como string
    return valuesLast
  }

  /**
   * Gera expressão SQL CASE WHEN segura para valuesLast: coloca os valores
   * especificados no final da ordenação. O SQL resultante é:
   *   CASE WHEN `col` IN (v1, v2, ...) THEN 1 ELSE 0 END
   * Usado como expressão primária de sort; a coluna real (ASC/DESC) fica
   * como expressão secundária para ordenar dentro de cada grupo.
   *
   * Seguro contra SQL injection: valores são passados via parâmetros do
   * drizzle (sql`` template), nunca concatenados como string.
   */
  private caseWhenValuesLast(
    coluna: Column,
    valuesLast: (string | number)[],
  ): ReturnType<typeof sql> {
    const valoresSql = sql.join(
      valuesLast.map((v) => sql`${v}`),
      sql`, `,
    )
    return sql`CASE WHEN ${coluna} IN (${valoresSql}) THEN 1 ELSE 0 END`
  }

  /**
   * Colunas indexáveis por texto para o search (LIKE case-insensível):
   * char, varchar e text (dataType string + columnType texto). JSON é
   * excluído para evitar SQL inválido (JSON não aceita LIKE).
   */
  private colunasDeTexto(tabela: MySqlTable): Column[] {
    const columnas = Object.values(getTableColumns(tabela)) as unknown as Column[]
    return columnas.filter((c) => {
      if (c.dataType !== "string") return false
      const tipo = c.columnType as string
      return tipo === "MySqlText" || tipo.startsWith("MySqlVarChar") || tipo.startsWith("MySqlChar")
    })
  }

  /**
   * Monta a condição de busca: OR de `lower(col) like %termo%` sobre as
   * colunas de texto da tabela.
   *
   * Por que `lower(col) like` e não `ilike`?
   * O Drizzle em MySQL renderiza `ilike` como o token literal `ilike`
   * (não SQL válido — o MySQL não tem operador ILIKE). Para busca
   * case-insensitive real, usamos `lower(col) like %termo%` (termo em
   * minúsculas). O MySQL com collation ci_ já é case-insensitive,
   * mas lower() garante a semântica independentemente da collation.
   * Sem termo ou sem coluna de texto → undefined (sem filtro).
   */
  private condicaoDeBusca(tabela: MySqlTable, search?: string) {
    const termo = search?.trim().toLowerCase()
    if (!termo) return undefined
    const colunas = this.colunasDeTexto(tabela)
    if (colunas.length === 0) return undefined
    const padrao = `%${termo}%`
    const condicoes = colunas.map((c) =>
      like(sql`lower(${c})`, padrao),
    )
    return condicoes.length === 1
      ? condicoes[0]
      : or(...condicoes)
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
    const busca = this.condicaoDeBusca(tabela, params.search)
    const condicoesFinais = busca ? [...condicoes, busca] : condicoes
    const onde = condicoesFinais.length > 0 ? and(...(condicoesFinais as never[])) : undefined

    // Valida e prepara orderBy contra a tabela ANTES de abrir conexão.
    const orderByCols = params.orderBy?.map((item) => {
      const coluna = this.colunaDaTabela(tabela, item.campo)
      const normalizedValuesLast = item.valuesLast
        ? this.validarValuesLast(coluna, item.valuesLast, item.campo)
        : undefined
      return { coluna, direction: item.direction, valuesLast: normalizedValuesLast }
    })

    const db = await this.dbDoProjeto(projeto)
    try {
      const total = await db
        .select({ quantidade: sql<number>`count(*)` })
        .from(tabela)
        .where(onde)

      // Build query with conditional orderBy
      const orderExpressions: unknown[] = []
      if (orderByCols) {
        for (const item of orderByCols) {
          if (item.valuesLast && item.valuesLast.length > 0) {
            // CASE WHEN coloca valuesLast no final; secundária: coluna ASC/DESC
            orderExpressions.push(
              asc(this.caseWhenValuesLast(item.coluna, item.valuesLast)),
            )
          }
          orderExpressions.push(
            item.direction === "desc"
              ? desc(item.coluna as never)
              : asc(item.coluna as never),
          )
        }
      }

      const baseQuery = db.select().from(tabela).where(onde)
      const items = await (
        orderExpressions.length > 0
          ? baseQuery.orderBy(...(orderExpressions as never[])).limit(pageSize).offset((page - 1) * pageSize)
          : baseQuery.limit(pageSize).offset((page - 1) * pageSize)
      )

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
      const valores = this.paraChavesDoDrizzle(tabela, parse.data as Record<string, unknown>)

      // Tarefas são executadas pelo agente do projeto captado, não pelo
      // projeto da plataforma cujo banco está sendo usado. Conferir apenas a
      // FK do banco permite apontar para a linha da biblioteca-global (ou para
      // qualquer outro projeto) e reproduz a falha do TaQui.
      if (resource === "tarefas") {
        const projetoId = Number(valores.projeto_id)
        if (!Number.isSafeInteger(projetoId) || projetoId <= 0) {
          throw new BadRequestException(
            "projeto_id inválido: informe o id numérico de projetos_captados do projeto da tarefa",
          )
        }
        const [projetoCaptado] = await db
          .select({ id: projetosCaptados.id, slug: projetosCaptados.slug })
          .from(projetosCaptados)
          .where(eq(projetosCaptados.id, projetoId))
          .limit(1)
        if (!projetoCaptado) {
          throw new BadRequestException(
            `projeto_id=${projetoId} não encontrado em projetos_captados. Verifique o projeto da tarefa.`,
          )
        }
        if (projetoCaptado.slug !== projeto.slug) {
          throw new BadRequestException(
            `projeto_id=${projetoId} aponta para "${projetoCaptado.slug}", ` +
            `mas o escopo atual é "${projeto.slug}". Use o projeto_id correto de projetos_captados.`,
          )
        }
      }
      const resultado = await db.insert(tabela).values(valores)
      const insertId = resultado[0].insertId

      // Pós-processamento: preencher external_id automaticamente para tarefas
      // O motor-v2 busca tarefas por external_id; se o CRUD não preenche, o botão
      // Start falha com "Tarefa nao encontrada". Gera task-biblioteca-{id} se não
      // foi fornecido explicitamente.
      if (resource === "tarefas" && !valores.external_id) {
        const externalId = `task-biblioteca-${insertId}`
        await db.execute(
          sql`UPDATE tarefas SET external_id = ${externalId} WHERE id = ${insertId}`
        )
      }

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
