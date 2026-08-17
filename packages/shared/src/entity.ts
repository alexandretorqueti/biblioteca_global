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

/** Parâmetros padronizados de listagem do CRUD genérico. */
export interface ListParams {
  page?: number
  pageSize?: number
  search?: string
  /** Filtros por coluna — validados contra o schema do projeto no back. */
  filters?: Record<string, string | number | boolean>
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
