import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise'

const CATALOG_TABLES = [
  'motor_actions', 'motor_catalog_proposals', 'motor_event_log', 'motor_events',
  'motor_model_cooldown', 'motor_occurrences', 'motor_patterns',
  'motor_primitives', 'motor_promotion_state', 'motor_reactions',
] as const

const CONFIG_TABLES = [
  'motor_events', 'motor_patterns', 'motor_primitives', 'motor_actions', 'motor_reactions',
] as const

const REQUIRED_COLUMNS: Record<string, string[]> = {
  motor_actions: ['id', 'code', 'name', 'description', 'primitives_json', 'on_partial_failure', 'is_terminal', 'active'],
  motor_events: ['id', 'code', 'name', 'category', 'scope', 'priority', 'active'],
  motor_patterns: ['id', 'event_id', 'pattern', 'match_type', 'match_target', 'active'],
  motor_primitives: ['id', 'code', 'name', 'domain'],
  motor_reactions: ['id', 'event_id', 'occurrence', 'action_id', 'active'],
}

const MIGRATION_LOCK = 'gerenteagentes_motor_v3_schema_preflight'
const MIGRATION_TABLE = '__drizzle_migrations'
type RuntimeConnection = Connection | Pool
type RuntimeMigration = { tag: string; when: number; hash: string; sql: string[] }

/**
 * Adota ou inicializa o catálogo v3 sem reexecutar a migration destrutiva em
 * bancos existentes. O lock protege dois containers blue/green iniciando ao
 * mesmo tempo.
 */
export async function bootstrapMotorV3Catalog(existingConnection?: RuntimeConnection): Promise<void> {
  const connection = existingConnection ?? await mysql.createConnection({
    host: process.env.MOTOR_MYSQL_HOST || process.env.MYSQL_HOST || 'host.docker.internal',
    port: Number(process.env.MOTOR_MYSQL_PORT || process.env.MYSQL_PORT || 3308),
    user: process.env.MOTOR_MYSQL_USER || process.env.MYSQL_USER || 'biblioteca',
    password: process.env.MOTOR_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.MOTOR_MYSQL_DATABASE || 'projeto_640',
    charset: 'utf8mb4',
    multipleStatements: true,
  })
  const ownsConnection = !existingConnection
  let locked = false
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      `SELECT GET_LOCK('${MIGRATION_LOCK}', 30) AS acquired`,
    )
    locked = Number(lockRows[0]?.acquired) === 1
    if (!locked) throw new Error(`timeout adquirindo advisory lock ${MIGRATION_LOCK}`)

    const migrations = await readRuntimeMigrations()
    await ensureMigrationTable(connection)
    const applied = await readAppliedMigrations(connection)

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
      await applyMigration(connection, migrations[0]!, applied)
      console.log('[Motor v3 bootstrap] Schema do catálogo criado')
    }

    await adoptLegacyMigrations(connection, migrations, applied, existing.size !== 0)

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
      await applyMigration(connection, migrations[1]!, applied)
      console.log('[Motor v3 bootstrap] Catálogo canônico populado')
    }

    for (const migration of migrations) {
      if (!applied.has(migration.hash)) await applyMigration(connection, migration, applied)
    }

    await validateRuntimeSchema(connection)

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
    if (locked) await connection.query(`SELECT RELEASE_LOCK('${MIGRATION_LOCK}')`)
    if (ownsConnection) await connection.end()
  }
}

async function readRuntimeMigrations(): Promise<RuntimeMigration[]> {
  const journalUrl = new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)
  const journal = JSON.parse(await readFile(journalUrl, 'utf8')) as { entries: Array<{ tag: string; when: number }> }
  return Promise.all(journal.entries.map(async entry => {
    const sqlText = await readFile(new URL(`../../drizzle/migrations/${entry.tag}.sql`, import.meta.url), 'utf8')
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(sqlText).digest('hex'),
      sql: sqlText.split('--> statement-breakpoint'),
    }
  }))
}

async function ensureMigrationTable(connection: RuntimeConnection): Promise<void> {
  await connection.query(`CREATE TABLE IF NOT EXISTS \`${MIGRATION_TABLE}\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    hash TEXT NOT NULL,
    created_at BIGINT
  )`)
}

async function readAppliedMigrations(connection: RuntimeConnection): Promise<Set<string>> {
  const [rows] = await connection.query<RowDataPacket[]>(`SELECT hash FROM \`${MIGRATION_TABLE}\``)
  return new Set(rows.map(row => String(row.hash)))
}

async function applyMigration(connection: RuntimeConnection, migration: RuntimeMigration, applied: Set<string>): Promise<void> {
  if (applied.has(migration.hash)) return
  try {
    for (const statement of migration.sql) {
      if (statement.trim()) await connection.query(statement)
    }
    await connection.query(`INSERT INTO \`${MIGRATION_TABLE}\` (hash, created_at) VALUES (?, ?)`, [migration.hash, migration.when])
    applied.add(migration.hash)
    console.log(`[Motor v3 bootstrap] Migration ${migration.tag} aplicada`)
  } catch (error) {
    throw new Error(`falha aplicando migration ${migration.tag} (schema esperado: runtime do Motor v3): ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

async function adoptLegacyMigrations(connection: RuntimeConnection, migrations: RuntimeMigration[], applied: Set<string>, legacyCatalog: boolean): Promise<void> {
  if (!legacyCatalog) return
  const checks: Record<string, string> = {
    '0000_mighty_blade': 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = \'motor_actions\'',
    '0001_catalog_reconcile': 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = \'motor_reactions\'',
    '0002_analysis_execution_claim': 'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = \'task_runtime_facts\' AND column_name = \'analysis_execution_id\'',
    '0003_motor_outbox': 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = \'motor_outbox\'',
    '0004_message_processing_state': 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = \'motor_message_processing_state\'',
    '0005_action_descriptions': 'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = \'motor_actions\' AND column_name = \'description\'',
  }
  for (const migration of migrations) {
    if (applied.has(migration.hash) || !checks[migration.tag]) continue
    const [rows] = await connection.query<RowDataPacket[]>(checks[migration.tag]!)
    if (rows.length > 0) {
      await connection.query(`INSERT INTO \`${MIGRATION_TABLE}\` (hash, created_at) VALUES (?, ?)`, [migration.hash, migration.when])
      applied.add(migration.hash)
    }
  }
}

async function validateRuntimeSchema(connection: RuntimeConnection): Promise<void> {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const placeholders = columns.map(() => '?').join(',')
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name IN (${placeholders})`,
      [table, ...columns],
    )
    const present = new Set(rows.map(row => String(row.COLUMN_NAME ?? row.column_name)))
    const missing = columns.filter(column => !present.has(column))
    if (missing.length > 0) {
      const expectedMigration = missing.includes('description') ? '0005_action_descriptions' : 'migration anterior do catálogo'
      throw new Error(`schema incompatível do Motor v3: ${table}.${missing.join(', ')} ausente(s); esperado por ${expectedMigration}`)
    }
  }
}

async function seedLegacyCatalogSlots(connection: RuntimeConnection): Promise<void> {
  const eventValues = Array.from({ length: 10 }, (_, index) => {
    const id = index + 1
    return `(${id}, 'LEGACY_EVENT_${id}', 'Slot legado ${id}', 'erro', 'subtarefa', ${id * 10}, 1)`
  }).join(',')
  await connection.query(
    `INSERT INTO motor_events (id, code, name, category, scope, priority, active) VALUES ${eventValues}`,
  )
  const actionValues = Array.from({ length: 5 }, (_, index) => {
    const id = index + 1
    return `(${id}, 'LEGACY_ACTION_${id}', 'Slot legado ${id}', NULL, JSON_ARRAY(), 'continue', 0, 1)`
  }).join(',')
  await connection.query(
    `INSERT INTO motor_actions (id, code, name, primitives_json, on_partial_failure, is_terminal, active) VALUES ${actionValues}`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrapMotorV3Catalog().catch(error => {
    console.error('[Motor v3 bootstrap] Falha:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
