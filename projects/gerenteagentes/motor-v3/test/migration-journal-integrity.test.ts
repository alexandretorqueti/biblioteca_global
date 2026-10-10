import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAddedMigrationsHaveJournalEntries,
  inspectMigrationJournals,
  inspectProjectMigrationJournal,
  MigrationJournalIntegrityError,
  MigrationJournalMonotonicityError,
  warnOnMigrationJournalIntegrity,
} from '../src/migrations/MigrationJournalIntegrity.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('MigrationJournalIntegrity', () => {
  it('exige correspondência exata entre nome SQL e tag', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_exact.sql'], tags: ['0001_different'], whens: [1000] } })
    const inspection = await inspectProjectMigrationJournal(root, 'alpha')
    expect(inspection.orphaned).toEqual([{ project: 'alpha', migration: '0001_exact.sql', expectedTag: '0001_exact' }])
    expect(inspection.monotonicityViolations).toEqual([])
  })

  it('reconhece migration registrada e deixa explícito journal inválido ou ausente', async () => {
    const root = await fixture({
      registered: { migrations: ['0001_registered.sql'], tags: ['0001_registered'], whens: [1000] },
      absent: { migrations: ['0002_absent.sql'] },
      malformed: { migrations: ['0003_malformed.sql'], rawJournal: '{invalid' },
    })
    await expect(inspectProjectMigrationJournal(root, 'registered')).resolves.toMatchObject({ orphaned: [], monotonicityViolations: [] })
    await expect(inspectProjectMigrationJournal(root, 'absent')).resolves.toMatchObject({ issue: 'journal_missing', monotonicityViolations: [] })
    await expect(inspectProjectMigrationJournal(root, 'malformed')).resolves.toMatchObject({ issue: 'journal_invalid_json', monotonicityViolations: [] })
  })

  it('no gate só reprova SQL adicionado desde o commit-base', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_historical.sql'], tags: [], whens: [] } })
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

  it('bloqueia journal com when não monotônico (menor ou igual ao anterior)', async () => {
    const root = await fixture({
      monotonic: {
        migrations: ['0001_first.sql', '0002_second.sql', '0003_third.sql'],
        tags: ['0001_first', '0002_second', '0003_third'],
        whens: [1000, 2000, 3000],
      },
      non_monotonic: {
        migrations: ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
        tags: ['0001_a', '0002_b', '0003_c'],
        whens: [1000, 2000, 1500], // violação: 1500 < 2000
      },
    })
    const inspectionMonotonic = await inspectProjectMigrationJournal(root, 'monotonic')
    expect(inspectionMonotonic.monotonicityViolations).toEqual([])
    const inspectionNonMonotonic = await inspectProjectMigrationJournal(root, 'non_monotonic')
    expect(inspectionNonMonotonic.monotonicityViolations).toHaveLength(1)
    expect(inspectionNonMonotonic.monotonicityViolations[0]).toMatchObject({
      project: 'non_monotonic',
      entryTag: '0003_c',
      entryIndex: 2,
      currentWhen: 1500,
      previousWhen: 2000,
      previousTag: '0002_b',
    })
  })

  it('bloqueia journal com when igual ao anterior', async () => {
    const root = await fixture({
      equal: {
        migrations: ['0001_a.sql', '0002_b.sql'],
        tags: ['0001_a', '0002_b'],
        whens: [1000, 1000], // violação: igual
      },
    })
    const inspection = await inspectProjectMigrationJournal(root, 'equal')
    expect(inspection.monotonicityViolations).toHaveLength(1)
    expect(inspection.monotonicityViolations[0]).toMatchObject({
      project: 'equal',
      entryTag: '0002_b',
      currentWhen: 1000,
      previousWhen: 1000,
    })
  })

  it('gate reprova journal não monotônico adicionado desde o commit-base', async () => {
    const root = await fixture({
      alpha: {
        migrations: ['0001_ok.sql', '0002_ok.sql'],
        tags: ['0001_ok', '0002_ok'],
        whens: [1000, 2000],
      },
    })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).resolves.toBeUndefined()

    // Adicionar nova migration com when não monotônico
    await writeFile(join(root, 'projects/alpha/migrations/0003_new.sql'), '-- new')
    const journalPath = join(root, 'projects/alpha/migrations/meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries.push({ tag: '0003_new', when: 1500 }) // menor que 2000
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationJournalMonotonicityError',
      violations: [{
        project: 'alpha',
        entryTag: '0003_new',
        currentWhen: 1500,
        previousWhen: 2000,
        previousTag: '0002_ok',
      }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow(/when=1500.*when=2000.*use when=3000/)
  })

  it('preflight avisa sem falhar e separa múltiplos projetos', async () => {
    const root = await fixture({
      alpha: { migrations: ['0001_orphan.sql'], tags: [], whens: [] },
      beta: { migrations: ['0002_ok.sql'], tags: ['0002_ok'], whens: [1000] },
      gamma: { migrations: ['0003_orphan.sql'] },
      delta: {
        migrations: ['0001_a.sql', '0002_b.sql'],
        tags: ['0001_a', '0002_b'],
        whens: [2000, 1000], // não monotônico
      },
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const inspections = await warnOnMigrationJournalIntegrity(root)
    expect(inspections).toHaveLength(4)
    expect(inspections.flatMap(inspection => inspection.orphaned).map(problem => problem.project).sort()).toEqual(['alpha', 'gamma'])
    expect(inspections.flatMap(inspection => inspection.monotonicityViolations).map(v => v.project)).toEqual(['delta'])
    expect(warning).toHaveBeenCalledTimes(3)
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'alpha', fatal: false }),
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'gamma', issue: 'journal_missing', fatal: false }),
      expect.objectContaining({
        event: 'migration_journal_integrity_warning',
        project: 'delta',
        monotonicityViolations: expect.arrayContaining([
          expect.objectContaining({ entryTag: '0002_b', currentWhen: 1000, previousWhen: 2000 }),
        ]),
        fatal: false,
      }),
    ]))
    warning.mockRestore()
    await expect(inspectMigrationJournals(root)).resolves.toHaveLength(4)
  })
})

async function fixture(projects: Record<string, { migrations: string[]; tags?: string[]; whens?: number[]; rawJournal?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-journal-'))
  roots.push(root)
  for (const [project, config] of Object.entries(projects)) {
    const migrationDirectory = join(root, 'projects', project, 'migrations')
    await mkdir(migrationDirectory, { recursive: true })
    await Promise.all(config.migrations.map(name => writeFile(join(migrationDirectory, name), '-- migration')))
    if (config.rawJournal !== undefined) {
      await mkdir(join(migrationDirectory, 'meta'), { recursive: true })
      await writeFile(join(migrationDirectory, 'meta', '_journal.json'), config.rawJournal)
    } else if (config.tags !== undefined) {
      await mkdir(join(migrationDirectory, 'meta'), { recursive: true })
      const entries = config.tags.map((tag, index) => ({
        tag,
        when: config.whens?.[index] ?? (index + 1) * 1000,
      }))
      await writeFile(join(migrationDirectory, 'meta', '_journal.json'), JSON.stringify({ entries }))
    }
  }
  return root
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout
}
