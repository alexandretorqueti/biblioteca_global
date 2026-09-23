import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'

interface ProjectRow extends RowDataPacket { id: number; slug: string }
interface CountRow extends RowDataPacket { total: number | string }
interface LockRow extends RowDataPacket { acquired: number | string }

const slugIsSafe = (slug: string): boolean => /^[a-z][a-z0-9-]*$/.test(slug)
const databaseFor = (projectId: number): string => `projeto_${projectId}`

function repositoryRoot(): string {
  const candidates = [process.env.MOTOR_REPO_ROOT_CONTAINER, process.env.REPO_PATH, '/data/workspace/projects/codigofonte/biblioteca-global', '/app']
    .filter((candidate): candidate is string => Boolean(candidate))
  const root = candidates.find(candidate => existsSync(resolve(candidate, 'package.json')))
  if (!root) throw new Error('Raiz do repositório não encontrada para migrations de projetos')
  return root
}

async function migrationCount(connection: mysql.Connection): Promise<number> {
  const [tables] = await connection.query<CountRow[]>(
    `SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '__drizzle_migrations'`,
  )
  if (Number(tables[0]?.total ?? 0) === 0) return 0
  const [migrations] = await connection.query<CountRow[]>('SELECT COUNT(*) AS total FROM __drizzle_migrations')
  return Number(migrations[0]?.total ?? 0)
}

async function main(): Promise<void> {
  const host = process.env.MYSQL_HOST || 'host.docker.internal'
  const port = Number(process.env.MYSQL_PORT || 3308)
  const password = process.env.MYSQL_ROOT_PASSWORD
  const coreDatabase = process.env.MYSQL_DATABASE || 'core'
  if (!password) throw new Error('MYSQL_ROOT_PASSWORD ausente para aplicar migrations de projetos')

  const core = await mysql.createConnection({ host, port, user: 'root', password, database: coreDatabase })
  let locked = false
  try {
    const [lockRows] = await core.query<LockRow[]>("SELECT GET_LOCK('motor:project-migrations', 60) AS acquired")
    if (Number(lockRows[0]?.acquired ?? 0) !== 1) throw new Error('Não foi possível obter lock para migrations de projetos')
    locked = true
    const [projects] = await core.query<ProjectRow[]>('SELECT id, slug FROM projetos WHERE ativo = 1 ORDER BY id')
    const root = repositoryRoot()
    for (const project of projects) {
      const id = Number(project.id)
      const slug = String(project.slug)
      if (!Number.isInteger(id) || id <= 0 || !slugIsSafe(slug)) throw new Error(`Projeto inválido para migration: id=${project.id} slug=${slug}`)
      const migrationsFolder = resolve(root, 'projects', slug, 'migrations')
      if (!existsSync(resolve(migrationsFolder, 'meta', '_journal.json'))) continue
      const database = databaseFor(id)
      const connection = await mysql.createConnection({ host, port, user: 'root', password, database })
      try {
        const before = await migrationCount(connection)
        await migrate(drizzle(connection), { migrationsFolder })
        const after = await migrationCount(connection)
        console.log(`[Motor v3] Migrations do projeto ${slug} (${database}): ${after - before} aplicada(s), ${after} total`)
      } finally {
        await connection.end()
      }
    }
  } finally {
    if (locked) await core.query("SELECT RELEASE_LOCK('motor:project-migrations')").catch(() => undefined)
    await core.end()
  }
}

main().catch(error => {
  console.error('[Motor v3] Falha ao aplicar migrations de projetos:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
