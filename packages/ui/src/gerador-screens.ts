/**
 * Tipos runtime das telas do GeradorSistema (montados a partir da config
 * serializável — PoC §7.4). Estes tipos NÃO são serializados; o
 * GeradorSistema os constrói injetando dataSource/registry/ícones.
 */
import type { ReactNode } from "react"
import type {
  CadastroDataSource,
  DynamicField,
  DynamicFieldConfig,
  EntityRecord,
  ExecuteAction,
} from "./types"
import type { JsonGridColumnConfig } from "./components/JsonGrid"
import type { CustomAction } from "@biblioteca-global/shared"

/** Tela filha (master-detail) em runtime. */
export interface GeradorSistemaChildScreen {
  childResource: string
  fkField: string
  label: string
  dataSource: CadastroDataSource<EntityRecord>
}

/** Rota filha com contexto em runtime (navegação hierárquica). */
export interface GeradorSistemaChildRoute {
  id: string
  label: string
  icon?: ReactNode
  targetResource: string
  filterField: string
  title?: string
  fields?: DynamicField[]
  columnLabels?: Record<string, string>
  hiddenColumns?: string[]
  columns?: 1 | 2 | 3
  newLabel?: string
  actions?: CustomAction[]
  /** Ações por linha (botões em cada registro da grid). */
  rowActions?: CustomAction[]
  /** Rotas filhas aninhadas (recursivo). */
  childRoutes?: GeradorSistemaChildRoute[]
  /** DataSource montado em runtime. */
  dataSource: CadastroDataSource<EntityRecord>
}

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
  /** Filhos para exibir no detalhe do registro pai. */
  children?: GeradorSistemaChildScreen[]
  /** Ações customizadas (botões com estado executando/sucesso/erro). */
  actions?: CustomAction[]
  /** Ações por linha (botões em cada registro da grid). */
  rowActions?: CustomAction[]
  /** Executa uma ação customizada (injetado pelo runtime; UI não fala HTTP). */
  executeAction?: ExecuteAction
  /** Rotas filhas com contexto (navegação hierárquica). */
  childRoutes?: GeradorSistemaChildRoute[]
}

export interface GeradorSistemaCustomScreen {
  kind: "custom"
  content: ReactNode
}

export interface GeradorSistemaExternalScreen {
  kind: "external"
  baseUrl: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  pathTemplate: string
  /** Ações customizadas (botões com estado executando/sucesso/erro). */
  actions?: CustomAction[]
  /** Caminho dentro da resposta para extrair o array de linhas. Ex.: 'projects'. */
  dataPath?: string
  /** Query estática opcional adicionada à URL como query string codificada. */
  query?: Record<string, string | number | boolean>
  /** Executa uma ação customizada (injetado pelo runtime; UI não fala HTTP). */
  executeAction?: ExecuteAction
  /** Template de caminho para detalhe do registro (master-detail). Interpola :campo com os params da linha. */
  detailPathTemplate?: string
  /** Caminho dentro da resposta de detalhe para extrair o objeto de dados. Ex.: 'task'. */
  detailDataPath?: string
  /** Colunas a ocultar na grid (lista e/ou detalhe). */
  hiddenColumns?: string[]
  /** Configuração de edição — quando presente, botões Editar aparecem nas linhas. */
  edit?: {
    method: "PUT" | "PATCH" | "POST"
    pathTemplate: string
    fields: DynamicFieldConfig[]
    bodyPath?: string
  }
}

export type GeradorSistemaScreen<T extends EntityRecord = EntityRecord> =
  | GeradorSistemaCadastroScreen<T>
  | GeradorSistemaCustomScreen
  | GeradorSistemaExternalScreen

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

/** Contexto de navegação hierárquica (filtro aplicado). */
export interface NavigationContext {
  filterField: string
  filterValue: string | number
  parentLabel?: string
  parentValue?: string | number
}
