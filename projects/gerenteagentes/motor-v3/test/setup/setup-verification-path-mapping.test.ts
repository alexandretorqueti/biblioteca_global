// @vitest-environment node
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * task-p2-1072 — resolução do diretório alvo do gate de artefatos de setup.
 *
 * O repo_path persistido pelo host usa o bind `/home/alexandre/codigofonte/...`
 * enquanto o container do Motor enxerga `/data/workspace/projects/codigofonte/...`
 * (namespace cross-container, cf. mapHostRepoPathToContainer em
 * execution/GitWorktreePreparer.ts — o mesmo mapeamento usado pelo preflight do
 * ConsoleAnalystRunner). Estes testes verificam que `persistAnalysis` resolve
 * `<repoRoot>/projects/<slug>` aplicando o mapeamento quando o caminho do host
 * não existe no container, sem caminho hardcoded.
 *
 * O fs é mockado (node:fs/promises) para controlar a existência dos candidatos
 * de forma determinística; a expectativa é sempre derivada de
 * mapHostRepoPathToContainer, nunca de literal duplicado.
 */

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(), access: vi.fn() }
})

import { access, stat } from 'node:fs/promises'
import type { AnalysisOutcome } from '../../src/analysis/AnalystReply.js'
import { MySqlTaskCoordinatorRepository } from '../../src/coordinator/index.js'
import { mapHostRepoPathToContainer } from '../../src/execution/GitWorktreePreparer.js'

const SLUG = 'gestao-de-tarefas-global'
const EXTERNAL_ID = `setup-${SLUG}`
const DB_TASK_ID = 1020
const PROJECT_ID = 6
const EXECUTION_ID = 'exec-1020'
const HOST_REPO_PATH = '/home/alexandre/codigofonte/biblioteca-global'

const validEvidence = {
  checklist: { structure: true, configSchemaMigrations: true, registries: true, repoPath: true },
  smoke_test: { url: 'http://localhost:3000/api/demo/', method: 'GET', status: 200, response_body: '{}', timestamp: '2026-11-14T00:00:00.000Z' },
}

function verificationOutcome(): AnalysisOutcome {
  return { kind: 'verification', verdict: 'Confirmado', summary: 'Setup concluído.', evidence: [JSON.stringify(validEvidence)] }
}

function createSetupConnection(repoPath: string | null) {
  const updates: Array<{ sql: string; params: unknown[] }> = []
  const state = { commits: 0, rollbacks: 0 }
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => { state.commits += 1 }),
    rollback: vi.fn(async () => { state.rollbacks += 1 }),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INNER JOIN task_runtime_facts') && sql.includes('FOR UPDATE')) {
        return [[{ id: DB_TASK_ID, tipo: 'verificacao', external_id: EXTERNAL_ID, projeto_id: PROJECT_ID, repo_path: repoPath }], []]
      }
      if (sql.includes('UPDATE analysis_clarification_checkpoints')) return [{ affectedRows: 0 }, []]
      if (sql.includes('UPDATE projetos_captados SET setup_status')) {
        updates.push({ sql, params })
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes('FROM tarefas t') && sql.includes('setup_not_verified')) return [[], []]
      if (sql.includes('INSERT INTO tarefa_chats')) return [{ affectedRows: 0 }, []]
      if (sql.includes('INSERT INTO task_runtime_facts')) return [{ affectedRows: 1 }, []]
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

/** Configura o fs mockado: apenas `existingDirs` existem; `existingFiles` são acessíveis. */
function mockFs(existingDirs: string[], existingFiles: string[]) {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  vi.mocked(stat).mockImplementation((async (path: string) => {
    if (existingDirs.includes(resolve(String(path)))) return { isDirectory: () => true }
    throw enoent()
  }) as never)
  vi.mocked(access).mockImplementation((async (path: string) => {
    if (!existingFiles.includes(resolve(String(path)))) throw enoent()
  }) as never)
}

describe('persistAnalysis — mapeamento cross-container na resolução do diretório de setup', () => {
  it('repo_path do host inexistente → usa o caminho mapeado do container para validar artefatos', async () => {
    const containerRepoRoot = mapHostRepoPathToContainer(HOST_REPO_PATH)
    expect(containerRepoRoot).toBeTruthy()
    const projectDir = join(containerRepoRoot!, 'projects', SLUG)
    mockFs([containerRepoRoot!, projectDir], [join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md')])

    const mock = createSetupConnection(HOST_REPO_PATH)
    const repository = createRepository(mock.connection)
    await repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome())

    // Ambos os candidatos foram consultados (original host + mapeado container).
    const statCalls = vi.mocked(stat).mock.calls.map(call => resolve(String(call[0])))
    expect(statCalls).toContain(resolve(HOST_REPO_PATH))
    expect(statCalls).toContain(resolve(containerRepoRoot!))
    // O artefato foi procurado no diretório mapeado, e o setup foi verificado.
    const accessCalls = vi.mocked(access).mock.calls.map(call => resolve(String(call[0])))
    expect(accessCalls).toContain(resolve(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md')))
    expect(mock.state.commits).toBe(1)
    expect(mock.updates.some(update => update.sql.includes("setup_status='verified'"))).toBe(true)
  })

  it('nenhum candidato acessível → setup_status=failed com repositório inacessível e erro propagado', async () => {
    mockFs([], [])
    const mock = createSetupConnection(HOST_REPO_PATH)
    const repository = createRepository(mock.connection)

    await expect(
      repository.persistAnalysis(EXTERNAL_ID, EXECUTION_ID, verificationOutcome()),
    ).rejects.toThrow(/Setup rejeitado pelo gate: .*repositório inacessível no container do Motor/)

    expect(mock.state.commits).toBe(0)
    expect(mock.state.rollbacks).toBe(1)
    const failed = mock.updates.filter(update => update.sql.includes("setup_status='failed'"))
    expect(failed).toHaveLength(1)
    expect(String(failed[0].params[0])).toContain('repositório inacessível no container do Motor')
    expect(mock.updates.some(update => update.sql.includes("setup_status='verified'"))).toBe(false)
  })
})
