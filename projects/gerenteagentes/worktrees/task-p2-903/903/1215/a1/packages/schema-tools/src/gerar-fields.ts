/**
 * Gerador de fields do DynamicForm a partir do schema Drizzle + annotations
 * (PoC §7.2). Uma escrita no schema.ts → fields da config JSON.
 */
import { getTableColumns, type Column } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { DynamicFieldConfig } from "@biblioteca-global/shared"
import { humanizarNome, type FormAnnotation } from "./form"
import { inferirFk } from "./inferir-fk"

export class TipoNaoSuportadoError extends Error {
  constructor(tabela: string, coluna: string, columnType: string) {
    super(
      `Tipo não suportado pelo gerador de fields: coluna "${coluna}" ` +
        `da tabela "${tabela}" (${columnType}). Defina o tipo do campo ` +
        `na annotation da coluna.`,
    )
    this.name = "TipoNaoSuportadoError"
  }
}

function derivarTipo(
  tabelaNome: string,
  coluna: Column,
): DynamicFieldConfig["type"] {
  const columnType = coluna.columnType

  if (columnType.startsWith("MySqlEnum")) return "select"
  if (columnType === "MySqlBoolean") return "switch"
  if (columnType === "MySqlText") return "textarea"
  if (columnType === "MySqlVarChar" || columnType === "MySqlChar") {
    return "text"
  }
  if (
    columnType === "MySqlTimestamp" ||
    columnType === "MySqlDate" ||
    columnType === "MySqlDatetime"
  ) {
    return "date"
  }
  if (coluna.dataType === "number" || coluna.dataType === "bigint") {
    return "number"
  }
  // JSON (MySqlJson): editor de JSON em árvore (FieldJson — 2026-08-16).
  if (columnType === "MySqlJson" || coluna.dataType === "json") return "json"
  // Fallbacks robustos por dataType (nomes de columnType variam no drizzle).
  if (coluna.dataType === "string") return "text"
  if (coluna.dataType === "boolean") return "switch"
  if (coluna.dataType === "date") return "date"

  throw new TipoNaoSuportadoError(tabelaNome, coluna.name, columnType)
}

function ehIgnoradaNoFormulario(coluna: Column): boolean {
  const meta = coluna as unknown as {
    primary?: boolean
    autoIncrement?: boolean
    generated?: unknown
  }
  return Boolean(meta.primary || meta.autoIncrement || meta.generated)
}

function enumDaColuna(coluna: Column): string[] | undefined {
  return (coluna as unknown as { enumValues?: string[] }).enumValues
}

/**
 * Gera os DynamicFieldConfig de uma tabela.
 * `anotacoes` = metadata por coluna (mapa `annotations` do schema).
 * `tabelas` = mapa de todas as tabelas do schema (opcional); quando fornecido,
 * campos FK (com `reference` no Drizzle) ganham type "multipleChoice" com
 * resource/displayField inferidos automaticamente (subtarefa #3).
 */
export function gerarFields(
  tabela: MySqlTable,
  tabelaNome: string,
  anotacoes: Record<string, FormAnnotation> = {},
  tabelas?: Record<string, MySqlTable>,
): DynamicFieldConfig[] {
  const fields: DynamicFieldConfig[] = []

  for (const coluna of Object.values(getTableColumns(tabela))) {
    if (ehIgnoradaNoFormulario(coluna)) continue

    const anotacao = anotacoes[coluna.name]
    const tipo = anotacao?.type ?? derivarTipo(tabelaNome, coluna)
    const required =
      anotacao?.required ?? (coluna.notNull && !coluna.hasDefault)

    const field: DynamicFieldConfig = {
      name: coluna.name,
      label: anotacao?.label ?? humanizarNome(coluna.name),
      type: tipo,
      required,
    }

    // Inferência automática de FK (subtarefa #3): campo com `reference` no
    // schema Drizzle vira combo de relacionamento. A annotation pode sobrescrever
    // o tipo (ex.: annotation.type = "text" mantém text, não vira multipleChoice).
    if (tabelas && !anotacao?.type) {
      const fk = inferirFk(tabela, coluna)
      if (fk) {
        field.type = "multipleChoice"
        field.multipleChoice = {
          resource: fk.resource,
          idField: "id",
          displayField: fk.displayField,
        }
      }
    }

    if (anotacao?.placeholder !== undefined) field.placeholder = anotacao.placeholder
    if (anotacao?.helperText !== undefined) field.helperText = anotacao.helperText
    if (anotacao?.fullWidth !== undefined) field.fullWidth = anotacao.fullWidth
    if (anotacao?.min !== undefined) field.min = anotacao.min
    if (anotacao?.max !== undefined) field.max = anotacao.max
    if (anotacao?.minLength !== undefined) field.minLength = anotacao.minLength
    if (anotacao?.maxLength !== undefined) field.maxLength = anotacao.maxLength
    if (anotacao?.currency !== undefined) field.currency = anotacao.currency
    if (anotacao?.mask !== undefined) field.mask = anotacao.mask
    if (anotacao?.validator !== undefined) field.validator = anotacao.validator
    if (anotacao?.disabled !== undefined) field.disabled = anotacao.disabled

    if (tipo === "select") {
      const valores = enumDaColuna(coluna)
      if (valores && valores.length > 0) {
        field.options = valores.map((valor) => ({
          label: humanizarNome(valor),
          value: valor,
        }))
      }
    }

    fields.push(field)
  }
  return fields
}
