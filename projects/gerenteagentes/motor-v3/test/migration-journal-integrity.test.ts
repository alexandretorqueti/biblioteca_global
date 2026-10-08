import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAddedMigrationsHaveJournalEntries,
  inspectMigrationJournals,
  inspectProjectMigrationJournal,
  MigrationJournalIntegrityError,
  warnOnMigrationJournalIntegrity,
} from '../src/migrations/MigrationJournalIntegrity.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('MigrationJournalIntegrity', () => {
  it('exige correspondência exata entre nome SQL e tag', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_exact.sql'], tags: ['0001_different'] } })
    const inspection = await inspectProjectMigrationJournal(root, 'alpha')
    expect(inspection.orphaned).toEqual([{ project: 'alpha', migration: '0001_exact.sql', expectedTag: '0001_exact' }])
  })

  it('reconhece migration registrada e deixa explícito journal inválido ou ausente', async () => {
    const root = await fixture({
      registered: { migrations: ['0001_registered.sql'], tags: ['0001_registered'] },
      absent: { migrations: ['0002_absent.sql'] },
      malformed: { migrations: ['0003_malformed.sql'], rawJournal: '{invalid' },
    })
    await expect(inspectProjectMigrationJournal(root, 'registered')).resolves.toMatchObject({ orphaned: [] })
    await expect(inspectProjectMigrationJournal(root, 'absent')).resolves.toMatchObject({ issue: 'journal_missing' })
    await expect(inspectProjectMigrationJournal(root, 'malformed')).resolves.toMatchObject({ issue: 'journal_invalid_json' })
  })

  it('no gate só reprova SQL adicionado desde o commit-base', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_historical.sql'], tags: [] } })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).resolves.toBeUndefined()
    await writeFile(join(root, 'projects/alpha/migrations/0002_new.sql'), '-- new')
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationJournalIntegrityError',
      problems: [{ project: 'alpha', migration: '0002_new.sql', expectedTag: '0002_new' }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow('Gere/atualize o journal junto com cada migration')
  })

  it('preflight avisa sem falhar e separa múltiplos projetos', async () => {
    const root = await fixture({
      alpha: { migrations: ['0001_orphan.sql'], tags: [] },
      beta: { migrations: ['0002_ok.sql'], tags: ['0002_ok'] },
      gamma: { migrations: ['0003_orphan.sql'] },
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const inspections = await warnOnMigrationJournalIntegrity(root)
    expect(inspections).toHaveLength(3)
    expect(inspections.flatMap(inspection => inspection.orphaned).map(problem => problem.project).sort()).toEqual(['alpha', 'gamma'])
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'alpha', fatal: false }),
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'gamma', issue: 'journal_missing', fatal: false }),
    ]))
    warning.mockRestore()
    await expect(inspectMigrationJournals(root)).resolves.toHaveLength(3)
  })
})

async function fixture(projects: Record<string, { migrations: string[]; tags?: string[]; rawJournal?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-journal-'))
  roots.push(root)
  for (const [project, config] of Object.entries(projects)) {
    const migrationDirectory = join(root, 'projects', project, 'migrations')
    await mkdir(migrationDirectory, { recursive: true })
    await Promise.all(config.migrations.map(name => writeFile(join(migrationDirectory, name), '-- migration')))
    if (config.rawJournal !== undefined || config.tags !== undefined) {
      await mkdir(join(migrationDirectory, 'meta'), { recursive: true })
      await writeFile(join(migrationDirectory, 'meta', '_journal.json'), config.rawJournal ?? JSON.stringify({ entries: config.tags!.map(tag => ({ tag })) }))
    }
  }
  return root
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout
}
