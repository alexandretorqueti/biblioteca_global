/**
 * Tipos base de entidades e do transporte REST genérico (PoC §6.2).
 */

/** Registro genérico de entidade persistida. */
export type EntityRecord = Record<string, unknown>

/**
 * Contrato de dados da tela Cadastro (v1, mantido — PoC §7.4): a UI nunca
 * fala HTTP; o api-client fornece implementações via createDataSource.
 */
export interface CadastroDataSource<T extends EntityRecord> {
  list(params?: ListParams): Promise<T[]>
  create(values: FieldValues): Promise<T>
  update(row: T, values: FieldValues): Promise<T>
  remove(row: T): Promise<void>
  getRowId(row: T): string | number
}

/** Valores de formulário aceitos pelos CRUDs gerados. */
export type FieldValues = Record<
  string,
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[]
>

/** Item de ordenação para listagem CRUD. */
export interface CrudOrderByItem {
  campo: string
  direction: "asc" | "desc"
  /**
   * Valores que vão para o final da ordenação (CASE WHEN seguro).
   * Ex.: valores de status "concluído"/"cancelado" aparecem por último.
   * Máximo 20 itens; tipos devem ser compatíveis com a coluna.
   */
  valuesLast?: (string | number)[]
}

/** Parâmetros padronizados de listagem do CRUD genérico. */
export interface ListParams {
  page?: number
  pageSize?: number
  search?: string
  /** Filtros por coluna — validados contra o schema do projeto no back. */
  filters?: Record<string, string | number | boolean>
  /** Ordenação por colunas — validada contra o schema no back. */
  orderBy?: CrudOrderByItem[]
}

/** Resposta paginada padronizada. */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** Erro padronizado da API (filtro global do NestJS). */
export interface ApiError {
  /** ex.: "VALIDATION_ERROR", "NOT_FOUND", "CONFLICT", "FORBIDDEN". */
  code: string
  message: string
  details?: unknown
}
