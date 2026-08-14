import type { ReactNode } from "react"
import type { DynamicField } from "./components/DynamicForm"
import type { JsonGridColumnConfig } from "./components/JsonGrid"

export type EntityRecord = Record<string, unknown>

export interface CadastroDataSource<T extends EntityRecord> {
  list(): Promise<T[]>
  create(values: Record<string, string | number | boolean>): Promise<T>
  update(
    row: T,
    values: Record<string, string | number | boolean>,
  ): Promise<T>
  remove(row: T): Promise<void>
  getRowId(row: T): string | number
}

export interface GeradorSistemaAppConfig {
  name: string
  logo?: ReactNode
}

export interface GeradorSistemaCadastroScreen<T extends EntityRecord> {
  kind: "cadastro"
  dataSource: CadastroDataSource<T>
  title: string
  fields: DynamicField[]
  columnLabels?: Record<string, string>
  gridColumns?: Record<string, JsonGridColumnConfig>
  hiddenColumns?: string[]
  columns?: 1 | 2 | 3
  newLabel?: string
  description?: string
}

export interface GeradorSistemaCustomScreen {
  kind: "custom"
  content: ReactNode
}

export interface GeradorSistemaRoute<T extends EntityRecord> {
  id: string
  label: string
  path: string
  description?: string
  icon?: ReactNode
  screen: GeradorSistemaCadastroScreen<T> | GeradorSistemaCustomScreen
}

export interface GeradorSistemaGroup<T extends EntityRecord> {
  id: string
  label: string
  items: GeradorSistemaRoute<T>[]
}

export interface GeradorSistemaConfig<T extends EntityRecord> {
  app: GeradorSistemaAppConfig
  groups: GeradorSistemaGroup<T>[]
  drawerWidth?: number
}
