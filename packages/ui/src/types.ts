export type EntityRecord = Record<string, unknown>

export interface CadastroDataSource<T extends EntityRecord> {
  list: () => Promise<T[]>
  create: (values: Record<string, string | number | boolean>) => Promise<T>
  update: (
    row: T,
    values: Record<string, string | number | boolean>,
  ) => Promise<T>
  remove: (row: T) => Promise<void>
  getRowId: (row: T) => string | number
}
