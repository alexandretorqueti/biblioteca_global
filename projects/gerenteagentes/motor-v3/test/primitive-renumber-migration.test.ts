import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPrimitiveByCode } from '../src/primitives/index.js'
import type { PrimitiveContext } from '../src/primitives/types.js'
import { renumberMigration } from '../src/primitives/git.js'

const journal = (entries: Array<{ idx: number; when: number; tag: string }>) =>
  JSON.stringify({ version: '7', dialect: 'mysql', entries: entries.map(entry => ({ ...entry, breakpoints: true })) })

const context = (worktreePath: string): PrimitiveContext => ({
  taskId: 'task-p1-1033',
  executionId: 'execution-test',
  generation: 1,
  projectSlug: 'gerenteagentes',
  repoPath: worktreePath,
  worktreePath,
  branchName: 'test',
  agentId: 'test-agent',
  db: {},
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-renumber-'))
  const migrations = join(root, 'projects/gerenteagentes/migrations')
  await mkdir(join(migrations, 'meta'), { recursive: true })
  return { root, journalPath: 'projects/gerenteagentes/migrations/meta/_journal.json', migrations }
}

describe('renumber_migration', () => {
  it('registra-se no catálogo de primitivas', () => {
    expect(getPrimitiveByCode('renumber_migration')).toBe(renumberMigration)
  })

  it('reproduz task-p1-1033: renumera 0094 para 0095 e coordena SQL, snapshot e journal', async () => {
    const { root, journalPath, migrations } = await fixture()
    try {
      await writeFile(join(migrations, '0094_deploy_execution_audit.sql'), 'select 1;')
      await writeFile(join(migrations, 'meta/0094_snapshot.json'), '{}')
      const ours = journal([
        { idx: 0, when: 1000, tag: '0000_base' },
        { idx: 94, when: 1_792_000_000_000, tag: '0094_motor_outbox_deferred_idempotency' },
      ])
      const base = journal([{ idx: 0, when: 1000, tag: '0000_base' }])
      const theirs = journal([
        { idx: 0, when: 1000, tag: '0000_base' },
        { idx: 94, when: 1_791_000_000_000, tag: '0094_deploy_execution_audit' },
      ])

      const result = await renumberMigration.handler(context(root), {
        journalPath,
        oursJournal: ours,
        baseJournal: base,
        theirsJournal: theirs,
      })

      expect(result.success).toBe(true)
      expect(result.data?.renames).toEqual([{ from: '0094_deploy_execution_audit', to: '0095_deploy_execution_audit', oldIdx: 94, newIdx: 95 }])
      expect(await readFile(join(migrations, '0095_deploy_execution_audit.sql'), 'utf8')).toBe('select 1;')
      expect(await readFile(join(migrations, 'meta/0095_snapshot.json'), 'utf8')).toBe('{}')
      const merged = JSON.parse(await readFile(join(root, journalPath), 'utf8')) as { entries: Array<{ idx: number; tag: string }> }
      expect(merged.entries.at(-1)).toMatchObject({ idx: 95, tag: '0095_deploy_execution_audit' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('pula slots ocupados em cadeia 0094 + 0095 e usa 0096', async () => {
    const { root, journalPath, migrations } = await fixture()
    try {
      await writeFile(join(migrations, '0094_deploy_execution_audit.sql'), 'select 1;')
      const ours = journal([
        { idx: 0, when: 1000, tag: '0000_base' },
        { idx: 94, when: 1_792_000_000_000, tag: '0094_first' },
        { idx: 95, when: 1_792_000_000_001, tag: '0095_second' },
      ])
      const base = journal([{ idx: 0, when: 1000, tag: '0000_base' }])
      const theirs = journal([
        { idx: 0, when: 1000, tag: '0000_base' },
        { idx: 94, when: 1_791_000_000_000, tag: '0094_deploy_execution_audit' },
      ])

      const result = await renumberMigration.handler(context(root), { journalPath, oursJournal: ours, baseJournal: base, theirsJournal: theirs })

      expect(result.success).toBe(true)
      expect(result.data?.renames[0]).toMatchObject({ oldIdx: 94, newIdx: 96, to: '0096_deploy_execution_audit' })
      expect(await readFile(join(migrations, '0096_deploy_execution_audit.sql'), 'utf8')).toBe('select 1;')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retorna sucesso sem alterar arquivos quando não há colisão', async () => {
    const { root, journalPath, migrations } = await fixture()
    try {
      const ours = journal([{ idx: 0, when: 1000, tag: '0000_base' }])
      const theirs = journal([
        { idx: 0, when: 1000, tag: '0000_base' },
        { idx: 1, when: 1001, tag: '0001_new_migration' },
      ])
      const result = await renumberMigration.handler(context(root), { journalPath, oursJournal: ours, baseJournal: ours, theirsJournal: theirs })

      expect(result).toMatchObject({ success: true, data: { changed: false, reason: 'no_collision' } })
      expect(await readFile(join(root, journalPath)).catch(() => null)).toBeNull()
      expect(await readFile(join(migrations, '0001_new_migration.sql')).catch(() => null)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
