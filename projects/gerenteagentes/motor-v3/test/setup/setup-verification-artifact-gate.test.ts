// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AnalysisOutcome } from '../../src/analysis/AnalystReply.js'
import { MySqlTaskCoordinatorRepository } from '../../src/coordinator/index.js'

/**
 * task-p2-1072 — regressão do caso real 1020→1063 (2026-11-14): o setup
 * terminou com evidência JSON válida e `setup_status` foi gravado como
 * `verified`, mas o diretório do projeto não continha
 * `docs/CONTEXTO-ANALISTA.md`; a tarefa dependente iniciou e falhou no
 * preflight do ConsoleAnalystRunner.
 *
 * Estes testes exercitam o caminho de verificação de `persistAnalysis`
 * (outcome.kind === 'verification', external_id 'setup-*') sobre um banco
 * mockado STATEFUL (padrão case-1029-cross-project-verdict.test.ts) e um
 * repositório real em diretório temporário:
 *
 * 1. evidência válida + artefato presente → setup_status='verified' e commit;
 * 2. evidência válida + artefato AUSENTE → setup_status='failed' com
 *    setup_error descritivo, erro propagado e rollback (projeto NÃO liberado);
 * 3. evidência inválida → comportamento do gate anterior permanece (failed).
 */

const SLUG = 'gestao-de-tarefas-global'
const EXTERNAL_ID = `setup-${SLUG}`
const DB_TASK_ID = 1020
const PROJECT_ID = 6
const EXECUTION_ID = 'exec-1020'

const validEvidence = {
  checklist: { structure: true, configSchemaMigrations: true, registries: true, repoPath: true },
  smoke_test: { url: 'http://localhost:3000/api/demo/', method: 'GET', status: 200, response_body: '{}', timestamp: '2026-11-14T00:00:00.000Z' },
}

function verificationOutcome(evidence: unknown): AnalysisOutcome {
  return {
    kind: 'verification',
    verdict: 'Confirmado',
    summary: 'Setup concluído.',
    evidence: [JSON.stringify(evidence)],
  }
}

interface RecordedUpdate {
  sql: string
  params: unknown[]
}

function createSetupConnection(repoPath: string | null) {
  const updates: RecordedUpdate[] = []
  const state = { commits: 0, rollbacks: 0 }
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => { state.commits += 1 }),
    rollback: vi.fn(async () => { state.rollbacks += 1 }),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      // Claim da análise (persistAnalysis): tarefa setup com lease ativo.
      if (sql.includes('INNER JOIN task_runtime_facts') && sql.includes('FOR UPDATE')) {
        return [[{ id: DB_TASK_ID, tipo: 'verificacao', external_id: EXTERNAL_ID, projeto_id: PROJECT_ID, repo_path: repoPath }], []]
      }
      if (sql.includes('UPDATE analysis_clarification_checkpoints')) return [{ affectedRows: 0 }, []]
      // Gravações de setup_status (verified/failed) — registradas para asserção.
      if (sql.includes('UPDATE projetos_captados SET setup_status')) {
        updates.push({ sql, params })
        return [{ affectedRows: 1 }, []]
      }
      // releaseProjectTasksAfterSetup: nenhuma tarefa retida legacy.
      if (sql.includes('FROM tarefas t') && sql.includes('setup_not_verified')) return [[], []]
      // Chat de verificação: deduplicado (affectedRows=0 → sem realtime de chat).
      if (sql.includes('INSERT INTO tarefa_chats')) return [{ affectedRows: 0 }, []]
      // Fato terminal completed.
      if (sql.includes('INSERT INTO task_runtime_facts')) return [{ affectedRows: 1 }, []]
      // RealtimeMutationBoundary.append (task.status.changed → closed).
      if (sql.includes('FROM tarefas WHERE id = ?')) {
        return [[{ id: DB_TASK_ID, external_id: EXTERNAL_ID, projeto_id: PROJECT_ID }], []]
      }
      if (sql.includes('realtime_event_outbox') && sql.includes('MAX(per_task_seq)')) return [[{ next_seq: 1 }], []]
      if (sql.includes('INSERT INTO realtime_event_outbox')) return [{ affectedRows: 1 }, []]
      return [[], []]
    }),
  }
  return { connection, updates, state }
}

function createRepository(connection: unknown): MySqlTaskCoordinatorRepository {
  return new MySqlTaskCoordinatorRepository({ getConnection: vi.fn(async () => connection) } as never)
}

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

/** Cria um repo temporário `projects/<slug>` com ou sem o artefato obrigatório. */
async function makeRepo(withArtifact: boolean): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'setup-verify-repo-'))
  tempDirs.push(repoRoot)
  const projectDir = join(repoRoot, 'projects', SLUG)
  await mkdir(join(projectDir, 'docs'), { recursive: true })
  if (withArtifact) {
    await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto do Analista\n')
  }
  return repoRoot
}

describe('persistAnalysis — gate de artefatos no caminho de verificação setup-*', () => {
  it('grava setup_status=verified somente com evidência válida E artefato em disco', async () => {
    const repoRoot = await makeRepo(true)
    const mock = createSetupConnection(repoRoot)
    const repository = createRepository(mock.connection)

    await repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome(validEvidence))

    expect(mock.state.commits).toBe(1)
    expect(mock.state.rollbacks).toBe(0)
    const verified = mock.updates.filter(update => update.sql.includes("setup_status='verified'"))
    expect(verified).toHaveLength(1)
    expect(verified[0].params[0]).toBe(JSON.stringify(validEvidence))
    expect(verified[0].params[1]).toBe(SLUG)
    expect(mock.updates.some(update => update.sql.includes("setup_status='failed'"))).toBe(false)
  })

  it('artefato ausente → setup_status=failed com setup_error descritivo, erro propagado e projeto não liberado', async () => {
    const repoRoot = await makeRepo(false)
    const mock = createSetupConnection(repoRoot)
    const repository = createRepository(mock.connection)

    await expect(
      repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome(validEvidence)),
    ).rejects.toThrow(/Setup rejeitado pelo gate: .*artefato obrigatório ausente: docs\/CONTEXTO-ANALISTA\.md/)

    expect(mock.state.commits).toBe(0)
    expect(mock.state.rollbacks).toBe(1)
    expect(mock.updates.some(update => update.sql.includes("setup_status='verified'"))).toBe(false)
    const failed = mock.updates.filter(update => update.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    expect(failed[0].params[1]).toBe(PROJECT_ID)
  })

  it('repo_path vazio → setup_status=failed (impossível validar artefatos) e erro propagado', async () => {
    const mock = createSetupConnection(null)
    const repository = createRepository(mock.connection)

    await expect(
      repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome(validEvidence)),
    ).rejects.toThrow(/Setup rejeitado pelo gate: .*repo_path do projeto ausente/)

    expect(mock.state.commits).toBe(0)
    const failed = mock.updates.filter(update => update.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain(`repo_path do projeto ausente para slug '${SLUG}'`)
  })

  it('evidência inválida continua rejeitada mesmo com artefato presente (gate anterior preservado)', async () => {
    const repoRoot = await makeRepo(true)
    const mock = createSetupConnection(repoRoot)
    const repository = createRepository(mock.connection)
    const invalid = { ...validEvidence, checklist: { ...validEvidence.checklist, registries: false } }

    await expect(
      repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome(invalid)),
    ).rejects.toThrow(/Setup rejeitado pelo gate: .*checklist incompleto: registries/)

    expect(mock.state.commits).toBe(0)
    expect(mock.updates.some(update => update.sql.includes("setup_status='verified'"))).toBe(false)
    const failed = mock.updates.filter(update => update.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('checklist incompleto: registries')
  })
})
