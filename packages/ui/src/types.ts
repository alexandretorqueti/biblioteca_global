/**
 * Tipos públicos da UI v2 (PoC §7).
 *
 * Ponte com o shared: a config do GeradorSistema é SERIALIZÁVEL (resource,
 * componentId, ícones por string). Os componentes internos continuam
 * recebendo dataSource/upload/loadOptions como funções — o GeradorSistema
 * monta esse runtime a partir da config (dataSource montado fora, registry
 * de telas custom, mapa de ícones).
 */
import type { ReactNode } from "react"
import type {
  CadastroDataSource,
  DynamicFieldConfig,
  EntityRecord,
  MultipleChoiceFieldConfig,
} from "@biblioteca-global/shared"

export type { EntityRecord, CadastroDataSource, FieldValues } from "@biblioteca-global/shared"
export type {
  GeradorSistemaAppConfig,
  GeradorSistemaConfig,
  ScreenConfig,
  CadastroScreenConfig,
  CustomScreenConfig,
} from "@biblioteca-global/shared"
export type {
  DynamicFieldConfig,
  DynamicFieldOption,
  DynamicFieldType,
  MultipleChoiceFieldConfig,
} from "@biblioteca-global/shared"

/** Campo de formulário em runtime: config serializável + função de upload opcional. */
export type DynamicField = DynamicFieldConfig & {
  /** Resolvido pelo runtime (uploadResource → função via api-client). */
  upload?: (file: File) => Promise<string>
  /** Runtime: aceita também data/loadOptions injetados pelo apps/web. */
  multipleChoice?: MultipleChoiceConfig
}

/** Config do multipleChoice em runtime: recurso + carregador opcional. */
export type MultipleChoiceConfig = MultipleChoiceFieldConfig & {
  data?: EntityRecord[]
  loadOptions?: (search: string) => Promise<EntityRecord[]>
}

/** Valores de formulário (iguais à v1). */
export type DynamicFormValues = Record<string, string | number | boolean>

/** Resolvedores de runtime injetados pelo apps/web (Etapa 9). */
export interface GeradorSistemaRuntime {
  /** Monta o CRUD do resource — apps/web usa o api-client (nunca HTTP direto). */
  getDataSource: (resource: string) => CadastroDataSource<EntityRecord>
  /** Resolve uploadResource → função de upload (opcional). */
  getUpload?: (resource: string) => (file: File) => Promise<string>
  /** Resolve resource → carregador de opções (opcional). */
  getLoadOptions?: (
    resource: string,
  ) => (search: string) => Promise<EntityRecord[]>
  /** Resolve nome do ícone → ReactNode (default: mapa interno). */
  resolveIcon?: (name: string) => ReactNode
}

export type {
  GeradorSistemaCadastroScreen,
  GeradorSistemaCustomScreen,
  GeradorSistemaGroup,
  GeradorSistemaRoute,
  GeradorSistemaScreen,
} from "./gerador-screens"
export type { JsonGridColumnConfig } from "./components/JsonGrid"
