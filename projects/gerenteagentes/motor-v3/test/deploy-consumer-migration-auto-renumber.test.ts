import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Auto-renumeration de migration em colisão de índice durante o compose do
 * batch (5 colisões em 2026-10-23). Quando o cherry-pick conflita SOMENTE no
 * `migrations/meta/_journal.json`, o compose renumera a migration do membro
 * para o próximo idx livre (sql + snapshot + journal) e segue com o lote, em
 * vez de isolar o membro para rebase manual.
 */

const calls: Array<{ command: string; args: string[] }> = []
let cherryPickFailCommits: Set<string> = new Set()
let conflictFileList: string[] = []
let occupiedTargets = false
let memberHasSnapshot = true
let stagedQuietSucceeds = false
let noopJournalScenario = false

const renames: Array<[string, string]> = []
const writes: Array<{ path: string; content: string }> = []

const JOURNAL_PATH = 'projects/gerenteagentes/migrations/meta/_journal.json'
const MIG_DIR = 'projects/gerenteagentes/migrations'

const oursJournal = JSON.stringify({
  version: '7', dialect: 'mysql', entries: [
    { idx: 0, when: 1000, tag: '0000_base', breakpoints: true },
    { idx: 94, when: 1_792_000_000_000, tag: '0094_motor_outbox_deferred_idempotency', breakpoints: true },
  ],
})
const baseJournal = JSON.stringify({
  version: '7', dialect: 'mysql', entries: [
    { idx: 0, when: 1000, tag: '0000_base', breakpoints: true },
  ],
})
const theirsJournal = JSON.stringify({
  version: '7', dialect: 'mysql', entries: [
    { idx: 0, when: 1000, tag: '0000_base', breakpoints: true },
    { idx: 94, when: 1_791_000_000_000, tag: '0094_deploy_execution_audit', breakpoints: true },
  ],
})

function cherryForCommit(inputCommit: string): string {
  return `cc${inputCommit.slice(0, 6)}${'c'.repeat(32)}`.slice(0, 40)
}

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => {
    if (typeof path !== 'string') return false
    // Alvos novos da renumeração: livres (false) ou ocupados (true)
    if (path.includes('0095_deploy_execution_audit.sql') || path.includes('0095_snapshot.json')) return occupiedTargets
    // Arquivos do membro vindos no cherry-pick: SQL sempre presente; snapshot
    // é opcional (migrations manuais do gerenteagentes não geram snapshot
    // desde 0018 — incidente task-p2-1047).
    if (path.includes('0094_deploy_execution_audit.sql')) return true
    if (path.includes('0094_snapshot.json')) return memberHasSnapshot
    return false
  }),
}))

vi.mock('node:fs/promises', () => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async (from: string, to: string) => { renames.push([from, to]) }),
  writeFile: vi.fn(async (path: string, content: string) => { writes.push({ path, content }) }),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args: [...args] })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return callback(null, { stdout: '/repo\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return callback(null, { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'worktree') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') {
      return callback(new Error('not ancestor'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry') {
      return callback(null, { stdout: `+ ${cherryForCommit(args[2] as string)}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'show' && String(args[1]).includes(JOURNAL_PATH)) {
      const stage = String(args[1]).split(':')[1]
      // Cenário noop: o commit do membro só ajusta o `when` de uma tag que já
      // existe no base do pick (ex.: 384dfa22 após renumeração) → stage 1
      // contém as mesmas tags do theirs → memberNew vazio → journal = ours.
      const content = stage === '1' ? (noopJournalScenario ? theirsJournal : baseJournal) : stage === '2' ? oursJournal : theirsJournal
      return callback(null, { stdout: content, stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args.includes('--continue')) {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--abort') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--skip') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick') {
      if (cherryPickFailCommits.has(args[1] as string)) {
        return callback(new Error(`CONFLICT (content): Merge conflict in ${conflictFileList.join(', ')}`), { stdout: '', stderr: '' })
      }
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return callback(null, { stdout: conflictFileList.join('\n') + '\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      // noop: índice idêntico ao HEAD após resolver o journal; senão, há
      // mudanças staged (conflito REAL não noop).
      return stagedQuietSucceeds ? callback(null, { stdout: '', stderr: '' }) : callback(new Error('has changes'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'checkout') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'add') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'npm') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'test') {
      return callback(new Error('not found'), { stdout: '', stderr: '' })
    }
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.composeBatch — auto-renumeration de migration em colisão de journal', () => {
  beforeEach(() => {
    calls.length = 0
    renames.length = 0
    writes.length = 0
    cherryPickFailCommits = new Set()
    conflictFileList = []
    occupiedTargets = false
    memberHasSnapshot = true
    stagedQuietSucceeds = false
    noopJournalScenario = false
  })

  const members = [
    { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
    { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
  ]

  it('conflito somente no journal → renumera 0094→0095 e segue sem isolar membro', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = [JOURNAL_PATH]

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    // Nenhum membro isolado
    expect(result.conflicts).toHaveLength(0)
    // cherry-pick concluído (continue) e nunca abortado
    expect(calls.some(c => c.command === 'git' && c.args.includes('--continue'))).toBe(true)
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(false)
    // SQL e snapshot renomeados
    expect(renames).toEqual([
      [`/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/0094_deploy_execution_audit.sql`, `/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/0095_deploy_execution_audit.sql`],
      [`/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/meta/0094_snapshot.json`, `/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/meta/0095_snapshot.json`],
    ])
    // Journal reescrito com a entrada renumerada anexada às da base
    expect(writes).toHaveLength(1)
    expect(writes[0]!.path).toBe(`/repo/.motor-v3-deploy-batch-test/${JOURNAL_PATH}`)
    const journal = JSON.parse(writes[0]!.content)
    expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toEqual([
      '0000_base', '0094_motor_outbox_deferred_idempotency', '0095_deploy_execution_audit',
    ])
    expect(journal.entries[2].idx).toBe(95)
    expect(journal.entries[2].when).toBeGreaterThan(journal.entries[1].when)
  })

  it('alvo da renumeração ocupado → não arrisca: isola o membro (comportamento vigente)', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = [JOURNAL_PATH]
    occupiedTargets = true

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({ taskId: 'task-2', index: 1 })
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('conflito fora de journal (código) → isolamento normal, sem auto-fix', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = ['projects/gerenteagentes/motor-v3/src/start.ts']

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    expect(result.conflicts).toHaveLength(1)
    expect(calls.some(c => c.command === 'git' && c.args.includes('--continue'))).toBe(false)
  })

  it('membro SEM snapshot (migrations manuais) → renumera SQL+journal e segue sem isolar', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = [JOURNAL_PATH]
    memberHasSnapshot = false

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    // Incidente task-p2-1047: a ausência do snapshot do membro fazia o
    // auto-renumber devolver false e isolar o membro.
    expect(result.conflicts).toHaveLength(0)
    expect(renames).toEqual([
      [`/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/0094_deploy_execution_audit.sql`, `/repo/.motor-v3-deploy-batch-test/${MIG_DIR}/0095_deploy_execution_audit.sql`],
    ])
    expect(calls.some(c => c.command === 'git' && c.args.includes('--continue'))).toBe(true)
    expect(writes).toHaveLength(1)
    const journal = JSON.parse(writes[0]!.content)
    expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain('0095_deploy_execution_audit')
  })

  it('pick journal-only noop (ajuste de when já absorvido) → --skip sem isolar e sem --continue', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = [JOURNAL_PATH]
    noopJournalScenario = true
    stagedQuietSucceeds = true

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    expect(result.conflicts).toHaveLength(0)
    expect(renames).toHaveLength(0)
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--skip')).toBe(true)
    expect(calls.some(c => c.command === 'git' && c.args.includes('--continue'))).toBe(false)
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(false)
  })

  it('conflito journal-only → auto-renumber roda ANTES do skipNoop (stages intactos)', async () => {
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    conflictFileList = [JOURNAL_PATH]

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', members)

    expect(result.conflicts).toHaveLength(0)
    // Bug de produção (task-p2-1047): skipNoop resolvia com `checkout --ours`
    // + `git add` antes do diagnóstico, apagando os stages :1:/:2:/:3: que o
    // auto-renumber precisa. Com a ordem correta, o autoResolve lê os stages
    // e o skipNoop nem chega a rodar.
    const showStageIdx = calls.findIndex(c => c.command === 'git' && c.args[0] === 'show' && String(c.args[1]).startsWith(':1:'))
    const checkoutOursIdx = calls.findIndex(c => c.command === 'git' && c.args[0] === 'checkout' && c.args.includes('--ours'))
    expect(showStageIdx).toBeGreaterThanOrEqual(0)
    expect(checkoutOursIdx).toBe(-1)
  })
})
