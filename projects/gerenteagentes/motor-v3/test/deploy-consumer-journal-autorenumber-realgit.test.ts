import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

/**
 * Regressão com GIT REAL do incidente task-p2-1047 (2026-11-01):
 *
 * 1. A base avançou com migrations que ocupam o idx 98/99 (0098_geracao_macro_f1,
 *    0099_setup_gate_legacy_block_cleanup) enquanto a integração do membro trazia
 *    0098_analyst_verification_routing → colisão de índice no compose do batch.
 * 2. Em produção o auto-renumber nunca disparava: o skipNoopCherryPickConflict
 *    rodava antes do diagnóstico e apagava os conflict stages (:1:/:2:/:3:).
 * 3. Mesmo com os stages intactos, o autoResolve exigia `meta/NNNN_snapshot.json`
 *    do membro — as migrations manuais do gerenteagentes não geram snapshot desde
 *    0018 → devolvia false e o membro era isolado.
 *
 * Os testes mockados (deploy-consumer-migration-auto-renumber.test.ts) não
 * reproduzem a destruição de estado do git real; este teste replica o compose
 * com git de verdade: cherry-pick conflitante → autoResolve → pick renumerado
 * (0100_*, when acima do watermark da base) e, em seguida, o pick noop de um
 * ajuste de `when` da tag antiga → --skip sem isolar.
 */

const MIG_DIR = 'projects/gerenteagentes/migrations'
const JOURNAL = `${MIG_DIR}/meta/_journal.json`

const W_BASE_98 = 1_793_555_000_001
const W_BASE_99 = 1_793_555_000_002
const W_MEMBER_OLD = 1_792_900_000_004

function journalFile(entries: Array<{ idx: number; when: number; tag: string }>): string {
  return `${JSON.stringify({
    version: '7',
    dialect: 'mysql',
    entries: entries.map(entry => ({ idx: entry.idx, version: '5', when: entry.when, tag: entry.tag, breakpoints: true })),
  }, null, 2)}\n`
}

const COMMON_ENTRIES = [
  { idx: 96, when: 1_792_900_000_002, tag: '0096_analysis_clarification_checkpoints' },
  { idx: 97, when: 1_792_900_000_003, tag: '0097_external_operation_evidence_prompt' },
]

let tempDirs: string[] = []

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function buildFixture(): Promise<{ repo: string; wt: string; memberSha: string; member2Sha: string; baseTipSubject: string }> {
  const repo = await makeTempDir('motor-realgit-repo-')
  git(['init', '-b', 'base-desenvolvimento', repo], repo)
  git(['config', 'user.email', 'motor@test.local'], repo)
  git(['config', 'user.name', 'Motor Test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)

  await mkdir(join(repo, MIG_DIR, 'meta'), { recursive: true })
  // merge-base: journal até 0097
  await writeFile(join(repo, JOURNAL), journalFile(COMMON_ENTRIES))
  await writeFile(join(repo, `${MIG_DIR}/0097_external_operation_evidence_prompt.sql`), '-- 0097\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'merge-base'], repo)
  const mergeBase = git(['rev-parse', 'HEAD'], repo).trim()

  // lado base: ocupa idx 98/99 (como 0098_geracao_macro_f1/0099_setup_gate)
  await writeFile(join(repo, JOURNAL), journalFile([
    ...COMMON_ENTRIES,
    { idx: 98, when: W_BASE_98, tag: '0098_geracao_macro_f1' },
    { idx: 99, when: W_BASE_99, tag: '0099_setup_gate_legacy_block_cleanup' },
  ]))
  await writeFile(join(repo, `${MIG_DIR}/0098_geracao_macro_f1.sql`), '-- 0098 base\n')
  await writeFile(join(repo, `${MIG_DIR}/0099_setup_gate_legacy_block_cleanup.sql`), '-- 0099 base\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'base: migrations 0098/0099'], repo)
  const baseTipSubject = git(['log', '-1', '--format=%s'], repo).trim()

  // lado membro: colide no idx 98, SEM snapshot (padrão real do gerenteagentes)
  git(['checkout', '-b', 'member', mergeBase], repo)
  await mkdir(join(repo, 'projects/gerenteagentes/motor-v3/src'), { recursive: true })
  await writeFile(join(repo, JOURNAL), journalFile([
    ...COMMON_ENTRIES,
    { idx: 98, when: W_MEMBER_OLD, tag: '0098_analyst_verification_routing' },
  ]))
  await writeFile(join(repo, `${MIG_DIR}/0098_analyst_verification_routing.sql`), '-- 0098 membro\n')
  await writeFile(join(repo, 'projects/gerenteagentes/motor-v3/src/member-code.ts'), 'export const memberCode = 1\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'membro: migration 0098_analyst_verification_routing'], repo)
  const memberSha = git(['rev-parse', 'HEAD'], repo).trim()

  // segundo commit do membro: só ajusta o when da tag antiga (família 384dfa22)
  await writeFile(join(repo, JOURNAL), journalFile([
    ...COMMON_ENTRIES,
    { idx: 98, when: 1_793_433_380_713, tag: '0098_analyst_verification_routing' },
  ]))
  git(['add', '-A'], repo)
  git(['commit', '-m', 'membro: ajuste de when da 0098'], repo)
  const member2Sha = git(['rev-parse', 'HEAD'], repo).trim()

  git(['checkout', 'base-desenvolvimento'], repo)

  // worktree destacado no tip da base (como o composeBatch faz)
  const wt = await makeTempDir('motor-realgit-wt-')
  await rm(wt, { recursive: true, force: true })
  git(['worktree', 'add', '--detach', wt, 'base-desenvolvimento'], repo)
  return { repo, wt, memberSha, member2Sha, baseTipSubject }
}

describe('DeployConsumer.autoResolveMigrationJournalConflicts — git real (incidente task-p2-1047)', () => {
  it('colisão de idx sem snapshot do membro → renumera 0098→0100 com when acima da base e conclui o pick', async () => {
    const { wt, memberSha } = await buildFixture()
    // cherry-pick conflitante somente no journal
    expect(() => git(['cherry-pick', memberSha], wt)).toThrow()
    expect(git(['diff', '--name-only', '--diff-filter=U'], wt).trim()).toBe(JOURNAL)

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const ok = await (consumer as any).autoResolveMigrationJournalConflicts(wt, [JOURNAL], 'batch-realgit', 'task-realgit', memberSha)
    expect(ok).toBe(true)

    // journal renumerado: 0100_analyst_verification_routing com when = maxWhen da base + 1
    const journal = JSON.parse(await readFile(join(wt, JOURNAL), 'utf8'))
    const last = journal.entries[journal.entries.length - 1]
    expect(last).toMatchObject({ idx: 100, tag: '0100_analyst_verification_routing', when: W_BASE_99 + 1 })
    expect(last.when).toBeGreaterThan(W_BASE_99)

    // SQL renomeado; código do membro presente; pick concluído (sem estado de conflito)
    expect(existsSync(join(wt, `${MIG_DIR}/0100_analyst_verification_routing.sql`))).toBe(true)
    expect(existsSync(join(wt, `${MIG_DIR}/0098_analyst_verification_routing.sql`))).toBe(false)
    expect(existsSync(join(wt, 'projects/gerenteagentes/motor-v3/src/member-code.ts'))).toBe(true)
    expect(git(['status', '--porcelain'], wt).trim()).toBe('')
    expect(() => git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], wt)).toThrow()
    expect(git(['log', '-1', '--format=%s'], wt).trim()).toBe('membro: migration 0098_analyst_verification_routing')
  }, 30_000)

  it('pick subsequente que só ajusta o when da tag antiga → noop: --skip sem isolar e sem novo commit', async () => {
    const { wt, memberSha, member2Sha } = await buildFixture()
    expect(() => git(['cherry-pick', memberSha], wt)).toThrow()
    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    expect(await (consumer as any).autoResolveMigrationJournalConflicts(wt, [JOURNAL], 'batch-realgit', 'task-realgit', memberSha)).toBe(true)
    const headAfterFirst = git(['rev-parse', 'HEAD'], wt).trim()

    // segundo pick (ajuste de when da tag já renumerada): conflito journal-only
    expect(() => git(['cherry-pick', member2Sha], wt)).toThrow()
    expect(git(['diff', '--name-only', '--diff-filter=U'], wt).trim()).toBe(JOURNAL)

    const ok = await (consumer as any).autoResolveMigrationJournalConflicts(wt, [JOURNAL], 'batch-realgit', 'task-realgit', member2Sha)
    expect(ok).toBe(true)

    // noop: HEAD não mudou, worktree limpo, sem estado de cherry-pick pendente
    expect(git(['rev-parse', 'HEAD'], wt).trim()).toBe(headAfterFirst)
    expect(git(['status', '--porcelain'], wt).trim()).toBe('')
    expect(() => git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], wt)).toThrow()
  }, 30_000)
})
