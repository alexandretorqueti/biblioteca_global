/**
 * Inferência automática de displayField para campos FK (subtarefa #3).
 *
 * Heurística em build time: campo terminado em "Id" com `reference` no schema
 * Drizzle vira combo de relacionamento (type: "multipleChoice"). A coluna
 * "legível" da tabela referenciada é resolvida na ordem:
 *   nome, name, titulo, title, label, descricao, description
 * Se nenhum existir, usa a primeira coluna string; se ainda assim não houver,
 * usa "id" com warning logado.
 *
 * Override explícito (displayField manual no config.ts) SEMPRE vence a
 * heurística — a config gerada é apenas sugestão inicial.
 */
import { getTableColumns, type Column } from "drizzle-orm"
import { getTableConfig, type MySqlTable } from "drizzle-orm/mysql-core"

/** Símbolo interno do drizzle que guarda o nome REAL da tabela. */
const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name")

/**
 * Colunas candidatas a displayField, em ordem de prioridade.
 * Nomes em snake_case (banco) — o drizzle guarda o nome real da coluna.
 */
const CANDIDATOS_DISPLAY: readonly string[] = [
  "nome",
  "name",
  "titulo",
  "title",
  "label",
  "descricao",
  "description",
]

/** Resultado da inferência de FK para um campo. */
export interface FkInferencia {
  /** Nome real da tabela referenciada (resource no CRUD). */
  resource: string
  /** Coluna da tabela referenciada usada como displayField. */
  displayField: string
  /** true se o displayField foi inferido (não declarado manualmente). */
  inferido: true
  /** true se caiu no fallback de ID com warning. */
  fallbackId: boolean
}

/**
 * Extrai as FKs inline de uma tabela Drizzle. Retorna array de
 * { colunaOrigem, tabelaReferenciada, colunaReferenciada }.
 */
function extrairFks(
  tabela: MySqlTable,
): Array<{
  colunaOrigem: Column
  tabelaDestino: MySqlTable
  nomeTabelaDestino: string
}> {
  const config = getTableConfig(tabela)
  const fks = config.foreignKeys
  if (!fks || fks.length === 0) return []

  const resultado: Array<{
    colunaOrigem: Column
    tabelaDestino: MySqlTable
    nomeTabelaDestino: string
  }> = []

  for (const fk of fks) {
    const ref = fk.reference()
    if (!ref.foreignTable || !ref.columns || ref.columns.length === 0) continue

    const tabelaDestino = ref.foreignTable as MySqlTable
    const nomeTabelaDestino = (tabelaDestino as unknown as Record<symbol, string>)[
      DRIZZLE_TABLE_NAME
    ]
    if (!nomeTabelaDestino) continue

    for (const colunaOrigem of ref.columns) {
      resultado.push({ colunaOrigem, tabelaDestino, nomeTabelaDestino })
    }
  }

  return resultado
}

/**
 * Resolve o displayField de uma tabela referenciada pela heurística.
 * Ordem: candidatos nomeados → primeira coluna string → "id" com warning.
 */
export function resolverDisplayField(
  tabelaDestino: MySqlTable,
  nomeTabelaDestino: string,
): { displayField: string; fallbackId: boolean } {
  const colunas = getTableColumns(tabelaDestino)
  const nomesColunas = Object.keys(colunas)

  // 1. Busca por candidatos nomeados (case-insensitive no snake_case)
  for (const candidato of CANDIDATOS_DISPLAY) {
    const encontrado = nomesColunas.find(
      (nome) => nome.toLowerCase() === candidato.toLowerCase(),
    )
    if (encontrado) {
      return { displayField: encontrado, fallbackId: false }
    }
  }

  // 2. Fallback: primeira coluna string (varchar/text/char)
  for (const [nome, coluna] of Object.entries(colunas)) {
    if (
      coluna.dataType === "string" &&
      (coluna.columnType === "MySqlVarChar" ||
        coluna.columnType === "MySqlChar" ||
        coluna.columnType === "MySqlText")
    ) {
      return { displayField: nome, fallbackId: false }
    }
  }

  // 3. Fallback final: "id" com warning
  // Declaração local para evitar dependência de @types/node no contexto
  // de importação por projetos frontend (que não têm types: ["node"]).
  ;(globalThis as { console?: { warn: (msg: string) => void } }).console?.warn(
    `[schema-tools] Tabela "${nomeTabelaDestino}" sem coluna legível para ` +
      `displayField. Usando "id" — defina displayField manualmente no config.ts.`,
  )
  return { displayField: "id", fallbackId: true }
}

/**
 * Verifica se um campo é FK (tem reference no schema Drizzle) e retorna a
 * inferência completa (resource + displayField). Retorna undefined se o
 * campo não é FK.
 */
export function inferirFk(
  tabela: MySqlTable,
  coluna: Column,
): FkInferencia | undefined {
  const fks = extrairFks(tabela)
  const fk = fks.find((f) => f.colunaOrigem.name === coluna.name)
  if (!fk) return undefined

  const { displayField, fallbackId } = resolverDisplayField(
    fk.tabelaDestino,
    fk.nomeTabelaDestino,
  )

  return {
    resource: fk.nomeTabelaDestino,
    displayField,
    inferido: true,
    fallbackId,
  }
}
