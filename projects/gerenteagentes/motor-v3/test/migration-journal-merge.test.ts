import { describe, expect, it } from 'vitest'
import { mergeJournals, parseJournal, renumberTag, snapshotNameForIdx } from '../src/deploy/MigrationJournalMerge.js'

/**
 * Renumereração automática de migration em colisão de índice no compose
 * (5 colisões em 2026-10-23: tarefas 1033, 1040, 1041, 1034, 1042).
 */
const journal = (entries: Array<{ idx: number; when: number; tag: string }>) =>
  JSON.stringify({ version: '7', dialect: 'mysql', entries: entries.map(e => ({ ...e, breakpoints: true })) })

describe('renumberTag', () => {
  it('renomeia prefixo numérico preservando o corpo', () => {
    expect(renumberTag('0094_deploy_execution_audit', 98)).toBe('0098_deploy_execution_audit')
    expect(renumberTag('0001_x', 12)).toBe('0012_x')
  })
})

describe('snapshotNameForIdx', () => {
  it('pad 4 dígitos', () => {
    expect(snapshotNameForIdx(98)).toBe('0098_snapshot.json')
  })
})

describe('parseJournal', () => {
  it('inválido → null', () => {
    expect(parseJournal('não-json')).toBeNull()
    expect(parseJournal(null)).toBeNull()
    expect(parseJournal(JSON.stringify({ version: '7' }))).toBeNull()
  })
})

describe('mergeJournals', () => {
  const ours = journal([
    { idx: 0, when: 1000, tag: '0000_base' },
    { idx: 94, when: 1_792_000_000_000, tag: '0094_motor_outbox_deferred_idempotency' },
  ])
  const base = journal([{ idx: 0, when: 1000, tag: '0000_base' }])
  const theirs = journal([
    { idx: 0, when: 1000, tag: '0000_base' },
    { idx: 94, when: 1_791_000_000_000, tag: '0094_deploy_execution_audit' },
  ])

  it('renumera entrada nova do membro para próximo idx livre e when monotônico', () => {
    const result = mergeJournals(ours, base, theirs)
    expect(result).not.toBeNull()
    expect(result!.journal.entries).toHaveLength(3)
    const appended = result!.journal.entries[2]!
    expect(appended).toMatchObject({ idx: 95, tag: '0095_deploy_execution_audit' })
    expect(appended.when).toBeGreaterThan(1_792_000_000_000)
    expect(result!.renames).toEqual([{ from: '0094_deploy_execution_audit', to: '0095_deploy_execution_audit', oldIdx: 94, newIdx: 95 }])
  })

  it('preserva when do membro quando já é maior que o máximo da base', () => {
    const theirsNewer = journal([
      { idx: 0, when: 1000, tag: '0000_base' },
      { idx: 94, when: 1_799_000_000_000, tag: '0094_deploy_execution_audit' },
    ])
    const result = mergeJournals(ours, base, theirsNewer)!
    expect(result.journal.entries[2]!.when).toBe(1_799_000_000_000)
  })

  it('múltiplas entradas novas do membro mantêm ordem relativa', () => {
    const theirsMulti = journal([
      { idx: 0, when: 1000, tag: '0000_base' },
      { idx: 94, when: 100, tag: '0094_a' },
      { idx: 95, when: 200, tag: '0095_b' },
    ])
    const result = mergeJournals(ours, base, theirsMulti)!
    expect(result.journal.entries.slice(2).map(e => e.tag)).toEqual(['0095_a', '0096_b'])
    const whens = result.journal.entries.map(e => e.when)
    expect(whens).toEqual([...whens].sort((a, b) => a - b))
  })

  it('add/add sem base: todas as entradas do theirs são novas', () => {
    const result = mergeJournals(ours, null, theirs)!
    expect(result.renames).toHaveLength(1)
    expect(result.journal.entries).toHaveLength(3)
  })

  it('theirs sem novidades (noop) → mantém ours sem renomeios', () => {
    const result = mergeJournals(ours, theirs, theirs)!
    expect(result.renames).toEqual([])
    expect(result.journal.entries).toHaveLength(2)
  })

  it('tag já presente em ours é ignorada (não duplica)', () => {
    const theirsSameTag = journal([
      { idx: 0, when: 1000, tag: '0000_base' },
      { idx: 94, when: 5, tag: '0094_motor_outbox_deferred_idempotency' },
    ])
    const result = mergeJournals(ours, base, theirsSameTag)!
    expect(result.renames).toEqual([])
    expect(result.journal.entries).toHaveLength(2)
  })

  it('journals inválidos → null', () => {
    expect(mergeJournals('x', base, theirs)).toBeNull()
    expect(mergeJournals(ours, base, null)).toBeNull()
  })
})
