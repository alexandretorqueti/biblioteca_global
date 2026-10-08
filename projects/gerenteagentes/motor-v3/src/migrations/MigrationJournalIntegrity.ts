import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const migrationPath = /^projects\/([^/]+)\/migrations\/([^/]+\.sql)$/

export interface MigrationJournalProblem {
  project: string
  migration: string
  expectedTag: string
}

export interface MigrationJournalInspection {
  project: string
  orphaned: MigrationJournalProblem[]
  issue?: 'journal_missing' | 'journal_unreadable' | 'journal_invalid_json' | 'journal_invalid_structure'
}

export class MigrationJournalIntegrityError extends Error {
  constructor(readonly problems: MigrationJournalProblem[], readonly inspections: MigrationJournalInspection[]) {
    super([
      'Migrations SQL adicionadas sem a tag correspondente no meta/_journal.json:',
      ...problems.map(problem => `- projects/${problem.project}/migrations/${problem.migration} (tag esperada: ${problem.expectedTag})`),
      'Gere/atualize o journal junto com cada migration antes de concluir a entrega.',
    ].join('\n'))
    this.name = 'MigrationJournalIntegrityError'
  }
}

/** Retorna a raiz do monorepo tanto em src/ quanto no build em dist/. */
export const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

export async function inspectProjectMigrationJournal(
  repositoryRoot: string,
  project: string,
  migrations?: string[],
): Promise<MigrationJournalInspection> {
  const migrationDirectory = resolve(repositoryRoot, 'projects', project, 'migrations')
  const names = migrations ?? await sqlMigrations(migrationDirectory)
  const journalPath = resolve(migrationDirectory, 'meta', '_journal.json')
  let journal: unknown
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'))
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      project,
      orphaned: names.map(migration => problem(project, migration)),
      issue: code === 'ENOENT' ? 'journal_missing' : error instanceof SyntaxError ? 'journal_invalid_json' : 'journal_unreadable',
    }
  }
  if (!isJournal(journal)) {
    return { project, orphaned: names.map(migration => problem(project, migration)), issue: 'journal_invalid_structure' }
  }
  const tags = new Set(journal.entries.map(entry => entry.tag))
  return { project, orphaned: names.filter(name => !tags.has(tagFor(name))).map(migration => problem(project, migration)) }
}

/** Varre todos os projetos acessíveis. Diretórios sem migrations são ignorados. */
export async function inspectMigrationJournals(repositoryRoot = defaultRepositoryRoot): Promise<MigrationJournalInspection[]> {
  let projects: string[]
  try { projects = await readdir(resolve(repositoryRoot, 'projects')) } catch { return [] }
  const inspections = await Promise.all(projects.map(async project => {
    const directory = resolve(repositoryRoot, 'projects', project, 'migrations')
    try { await readdir(directory) } catch { return null }
    return inspectProjectMigrationJournal(repositoryRoot, project)
  }))
  return inspections.filter((inspection): inspection is MigrationJournalInspection => inspection !== null)
}

/**
 * Gate diferencial: apenas migrations adicionadas desde o commit-base podem
 * bloquear a entrega. Pendências anteriores continuam visíveis no boot, mas
 * não reprovam uma subtarefa que não as introduziu.
 */
export async function assertAddedMigrationsHaveJournalEntries(workspacePath: string, baseCommit: string): Promise<void> {
  const added = await addedMigrationPaths(workspacePath, baseCommit)
  const byProject = new Map<string, string[]>()
  for (const path of added) {
    const match = migrationPath.exec(path)
    if (!match) continue
    const [, project, migration] = match
    if (!project || !migration) continue
    byProject.set(project, [...(byProject.get(project) ?? []), migration])
  }
  const inspections = await Promise.all([...byProject.entries()].map(([project, migrations]) =>
    inspectProjectMigrationJournal(workspacePath, project, migrations),
  ))
  const problems = inspections.flatMap(inspection => inspection.orphaned)
  if (problems.length > 0) throw new MigrationJournalIntegrityError(problems, inspections)
}

/** Preflight observável e deliberadamente não fatal para pendências históricas. */
export async function warnOnMigrationJournalIntegrity(repositoryRoot = defaultRepositoryRoot): Promise<MigrationJournalInspection[]> {
  const inspections = await inspectMigrationJournals(repositoryRoot)
  for (const inspection of inspections) {
    if (inspection.orphaned.length === 0 && !inspection.issue) continue
    console.warn(JSON.stringify({
      event: 'migration_journal_integrity_warning',
      project: inspection.project,
      issue: inspection.issue ?? null,
      orphanedMigrations: inspection.orphaned.map(orphan => ({ file: orphan.migration, expectedTag: orphan.expectedTag })),
      fatal: false,
    }))
  }
  return inspections
}

async function addedMigrationPaths(workspacePath: string, baseCommit: string): Promise<string[]> {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '--diff-filter=A', baseCommit, '--'], { cwd: workspacePath, encoding: 'utf8' }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspacePath, encoding: 'utf8' }),
  ])
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))]
}

async function sqlMigrations(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith('.sql')) } catch { return [] }
}

function tagFor(migration: string): string { return migration.slice(0, -'.sql'.length) }
function problem(project: string, migration: string): MigrationJournalProblem {
  return { project, migration, expectedTag: tagFor(migration) }
}
function isJournal(value: unknown): value is { entries: Array<{ tag: string }> } {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as { entries?: unknown }).entries)
    && (value as { entries: unknown[] }).entries.every(entry => typeof entry === 'object' && entry !== null && typeof (entry as { tag?: unknown }).tag === 'string')
}
