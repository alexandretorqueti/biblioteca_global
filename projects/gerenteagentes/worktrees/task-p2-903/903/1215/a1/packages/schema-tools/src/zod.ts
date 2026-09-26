/**
 * Schemas Zod derivados das tabelas Drizzle (validação nunca diverge da
 * tabela — PoC §7.2). Insert: colunas notNull sem default são exigidas;
 * defaults são opcionais; PK autoincrement/geradas ficam de fora.
 * Update: parcial e strict.
 */
import { getTableColumns, type Column } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { z, type ZodTypeAny } from "zod"

function tipoZodDaColuna(coluna: Column): ZodTypeAny {
  const columnType = coluna.columnType

  if (columnType.startsWith("MySqlEnum")) {
    const valores = (coluna as unknown as { enumValues?: [string, ...string[]] })
      .enumValues
    if (valores && valores.length > 0) {
      return z.enum(valores)
    }
    return z.string()
  }

  switch (coluna.dataType) {
    case "number":
    case "bigint":
      return z.number()
    case "boolean":
      return z.boolean()
    case "date":
      return z.union([z.date(), z.string()])
    case "json":
      return z.unknown()
    case "string": {
      const texto = z.string()
      const length = (
        coluna as unknown as { config?: { length?: number } }
      ).config?.length
      return length !== undefined ? texto.max(length) : texto
    }
    default:
      return z.unknown()
  }
}

/**
 * O Drizzle marca em `notNull` se uma coluna aceita `NULL`. A ausência do
 * campo no payload é diferente de enviar `null`: em atualizações parciais,
 * `null` é usado para limpar uma coluna nullable.
 */
function tipoZodParaEntrada(coluna: Column): ZodTypeAny {
  const tipo = tipoZodDaColuna(coluna)
  return coluna.notNull ? tipo : tipo.nullable()
}

function ehExcluidaDoInsert(coluna: Column): boolean {
  const meta = coluna as unknown as {
    primary?: boolean
    autoIncrement?: boolean
    generated?: unknown
  }
  return Boolean(meta.primary || meta.autoIncrement || meta.generated)
}

/** Schema de criação (POST). */
export function zodParaInsert(tabela: MySqlTable): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {}
  for (const coluna of Object.values(getTableColumns(tabela))) {
    if (ehExcluidaDoInsert(coluna)) continue
    const tipo = tipoZodParaEntrada(coluna)
    const requerida = coluna.notNull && !coluna.hasDefault
    shape[coluna.name] = requerida ? tipo : tipo.optional()
  }
  return z.object(shape).strict()
}

/** Schema de atualização parcial (PUT). */
export function zodParaUpdate(tabela: MySqlTable): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {}
  for (const coluna of Object.values(getTableColumns(tabela))) {
    if (ehExcluidaDoInsert(coluna)) continue
    shape[coluna.name] = tipoZodParaEntrada(coluna).optional()
  }
  return z.object(shape).strict()
}
