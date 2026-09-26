import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'

const CATALOG_TABLES = [
  'motor_actions', 'motor_catalog_proposals', 'motor_event_log', 'motor_events',
  'motor_model_cooldown', 'motor_occurrences', 'motor_patterns',
  'motor_primitives', 'motor_promotion_state', 'motor_reactions',
] as const

const CONFIG_TABLES = [
  'motor_events', 'motor_patterns', 'motor_primitives', 'motor_actions', 'motor_reactions',
] as const

/**
 * Adota ou inicializa o catálogo v3 sem reexecutar a migration destrutiva em
 * bancos existentes. O lock protege dois containers blue/green iniciando ao
 * mesmo tempo.
 */
export async function bootstrapMotorV3Catalog(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.MOTOR_MYSQL_HOST || process.env.MYSQL_HOST || 'host.docker.internal',
    port: Number(process.env.MOTOR_MYSQL_PORT || process.env.MYSQL_PORT || 3308),
    user: process.env.MOTOR_MYSQL_USER || process.env.MYSQL_USER || 'biblioteca',
    password: process.env.MOTOR_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.MOTOR_MYSQL_DATABASE || 'projeto_640',
    charset: 'utf8mb4',
    multipleStatements: true,
  })
  let locked = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK('gerenteagentes_motor_v3_catalog_bootstrap', 30) AS acquired",
    )
    locked = Number(lockRows[0]?.acquired) === 1
    if (!locked) throw new Error('timeout adquirindo lock de bootstrap do catálogo v3')

    const placeholders = CATALOG_TABLES.map(() => '?').join(',')
    const [tableRows] = await connection.query<RowDataPacket[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
      [...CATALOG_TABLES],
    )
    const existing = new Set(tableRows.map(row => String(row.TABLE_NAME ?? row.table_name)))
    if (existing.size !== 0 && existing.size !== CATALOG_TABLES.length) {
      const missing = CATALOG_TABLES.filter(table => !existing.has(table))
      throw new Error(`schema parcial do catálogo v3; tabelas ausentes: ${missing.join(', ')}`)
    }
    if (existing.size === 0) {
      await connection.query(await migrationSql('0000_mighty_blade.sql'))
      console.log('[Motor v3 bootstrap] Schema do catálogo criado')
    }

    const counts = new Map<string, number>()
    for (const table of CONFIG_TABLES) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table}`)
      counts.set(table, Number(rows[0]?.total ?? 0))
    }
    const populated = [...counts.values()].filter(count => count > 0).length
    if (populated !== 0 && populated !== CONFIG_TABLES.length) {
      throw new Error(`catálogo v3 parcialmente populado: ${JSON.stringify(Object.fromEntries(counts))}`)
    }
    if (populated === 0) {
      // O reconciliador histórico preserva IDs 1..10 de eventos e 1..5 de
      // ações. Em instalação nova esses slots ainda não existem; criá-los
      // explicitamente torna a mesma reconciliação válida em banco vazio.
      await seedLegacyCatalogSlots(connection)
      await connection.query(await migrationSql('0001_catalog_reconcile.sql'))
      console.log('[Motor v3 bootstrap] Catálogo canônico populado')
    }

    const minimums: Record<string, number> = {
      motor_events: 35,
      motor_patterns: 18,
      motor_primitives: 32,
      motor_actions: 20,
      motor_reactions: 21,
    }
    for (const [table, minimum] of Object.entries(minimums)) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table}`)
      const total = Number(rows[0]?.total ?? 0)
      if (total < minimum) throw new Error(`catálogo v3 incompleto: ${table} possui ${total}, mínimo ${minimum}`)
    }
    console.log('[Motor v3 bootstrap] Catálogo validado')
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('gerenteagentes_motor_v3_catalog_bootstrap')")
    await connection.end()
  }
}

async function seedLegacyCatalogSlots(connection: Connection): Promise<void> {
  const eventValues = Array.from({ length: 10 }, (_, index) => {
    const id = index + 1
    return `(${id}, 'LEGACY_EVENT_${id}', 'Slot legado ${id}', 'erro', 'subtarefa', ${id * 10}, 1)`
  }).join(',')
  await connection.query(
    `INSERT INTO motor_events (id, code, name, category, scope, priority, active) VALUES ${eventValues}`,
  )
  const actionValues = Array.from({ length: 5 }, (_, index) => {
    const id = index + 1
    return `(${id}, 'LEGACY_ACTION_${id}', 'Slot legado ${id}', JSON_ARRAY(), 'continue', 0, 1)`
  }).join(',')
  await connection.query(
    `INSERT INTO motor_actions (id, code, name, primitives_json, on_partial_failure, is_terminal, active) VALUES ${actionValues}`,
  )
}

async function migrationSql(file: string): Promise<string> {
  const url = new URL(`../../drizzle/migrations/${file}`, import.meta.url)
  return (await readFile(url, 'utf8')).replaceAll('--> statement-breakpoint', '')
}

bootstrapMotorV3Catalog().catch(error => {
  console.error('[Motor v3 bootstrap] Falha:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
