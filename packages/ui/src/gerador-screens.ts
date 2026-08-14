/**
 * Tipos runtime das telas do GeradorSistema (montados a partir da config
 * serializável — PoC §7.4). Estes tipos NÃO são serializados; o
 * GeradorSistema os constrói injetando dataSource/registry/ícones.
 */
import type { ReactNode } from "react"
import type {
  CadastroDataSource,
  DynamicField,
  EntityRecord,
} from "./types"
import type { JsonGridColumnConfig } from "./components/JsonGrid"

export interface GeradorSistemaCadastroScreen<T extends EntityRecord = EntityRecord> {
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

export type GeradorSistemaScreen<T extends EntityRecord = EntityRecord> =
  | GeradorSistemaCadastroScreen<T>
  | GeradorSistemaCustomScreen

export interface GeradorSistemaRoute<T extends EntityRecord = EntityRecord> {
  id: string
  label: string
  path: string
  description?: string
  icon?: ReactNode
  screen: GeradorSistemaScreen<T>
}

export interface GeradorSistemaGroup<T extends EntityRecord = EntityRecord> {
  id: string
  label: string
  items: GeradorSistemaRoute<T>[]
}
