// @vitest-environment node
// Gate de execução do setup como ESPERA DE CAPACIDADE (task-p2-1056, subtarefa 6).
// docs/TAXONOMIA-ERROS-MOTOR.md: bloqueio é exclusivo do caminho 'work'; espera
// de ambiente/capacidade nunca gera bloqueio nem consome attempt — o claim
// retorna 'capacity_waiting' e o TaskCoordinator re-enfileira com backoff
// (requeueForDeployRetry 'analysis_capacity_waiting', coberto em
// test/task-coordinator.test.ts).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MySqlTaskCoordinatorRepository } from '../src/coordinator/index.js'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42, external_id: 'task-1', projeto_id: 7, paused_at: null, auto_start: 1,
    setup_status: 'pending', analysis_started_at: null, analysis_execution_id: null,
    terminal_status: null, subtask_count: 0, blocked_count: 0,
    ...overrides,
  }
}

function connectionMock(row: Record<string, unknown>) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const sqlText = String(sql)
      if (sqlText.includes('FOR UPDATE') && sqlText.includes('FROM tarefas t')) return [[row], []]
      if (sqlText.includes('FROM motor_configuracoes')) {
        return [[{ chave: 'motor.max_workers', limite: 5 }, { chave: 'motor.max_workers_per_project', limite: 5 }], []]
      }
      if (sqlText.includes('COUNT(*) AS total')) return [[{ total: 0 }], []]
      if (sqlText.includes('project_model_selection')) return [[{ model: null, provider: null }], []]
      if (sqlText.includes('UPDATE task_runtime_facts') && sqlText.includes('analysis_execution_id = ?')) return [{ affectedRows: 1 }, []]
      return [[], []]
    }),
  }
  return { connection, calls }
}

function repositoryWith(connection: unknown) {
  const pool = { getConnection: vi.fn(async () => connection), query: vi.fn(async () => [[], []]) }
  return new MySqlTaskCoordinatorRepository(pool as any)
}

describe('gate de setup — espera de capacidade, nunca bloqueio', () => {
  it('setup pendente: claim retorna capacity_waiting, registra espera e NÃO insere bloqueio', async () => {
    const { connection, calls } = connectionMock(lockedRow({ setup_status: 'pending' }))
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe('capacity_waiting')

    // Nenhum bloqueio (TAXONOMIA-ERROS-MOTOR.md: espera de capacidade nunca bloqueia).
    expect(calls.some(call => call.sql.includes('INSERT INTO bloqueios'))).toBe(false)
    // Espera de capacidade registrada com reason 'setup_not_verified'.
    const wait = calls.find(call => call.sql.includes('UPDATE task_runtime_facts SET capacity_wait_phase=?'))
    expect(wait).toBeDefined()
    expect(wait?.params).toEqual(['analysis', 'setup_not_verified', 'project', 0, null, 42])
    // Transação commitada (fato durável) e sem rollback; sem claim de análise.
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(calls.some(call => call.sql.includes('SET analysis_started_at = NOW()'))).toBe(false)
  })

  it('cobre o despacho em geral: tarefa SEM auto_start também é retida (sem consumir limite/attempt)', async () => {
    const { connection, calls } = connectionMock(lockedRow({ auto_start: 0, setup_status: 'running' }))
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe('capacity_waiting')

    expect(calls.some(call => call.sql.includes('INSERT INTO bloqueios'))).toBe(false)
    // O gate antecede a checagem de limites: nenhuma consulta a motor_configuracoes.
    expect(calls.some(call => call.sql.includes('FROM motor_configuracoes'))).toBe(false)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('setup verified: claim normal, sem espera de capacidade', async () => {
    const { connection, calls } = connectionMock(lockedRow({ setup_status: 'verified' }))
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe(true)

    const claim = calls.find(call => call.sql.includes('SET analysis_started_at = NOW()'))
    expect(claim).toBeDefined()
    const setupWait = calls.find(call =>
      call.sql.includes('capacity_wait_reason_code=?') && call.params.includes('setup_not_verified'))
    expect(setupWait).toBeUndefined()
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('tarefa do próprio setup (external_id setup-*) nunca é retida, mesmo com setup pendente', async () => {
    const { connection, calls } = connectionMock(lockedRow({ external_id: 'setup-biblioteca', setup_status: 'pending' }))
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('setup-biblioteca', 'exec-1')).resolves.toBe(true)

    expect(calls.some(call => call.sql.includes('INSERT INTO bloqueios'))).toBe(false)
    expect(calls.some(call => call.sql.includes('SET analysis_started_at = NOW()'))).toBe(true)
  })

  it('tarefa sem projeto não passa pelo gate de setup', async () => {
    const { connection } = connectionMock(lockedRow({ projeto_id: null, setup_status: null }))
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe(true)
  })

  it('migration 0099 resolve bloqueios legados setup_not_verified de forma idempotente e o código não os cria mais', async () => {
    const [migration, repository] = await Promise.all([
      readFile(`${projectRoot}/migrations/0099_setup_gate_legacy_block_cleanup.sql`, 'utf8'),
      readFile(new URL('../src/coordinator/MySqlTaskCoordinatorRepository.ts', import.meta.url), 'utf8'),
    ])

    // DML pura e re-executável (WHERE resolved_at IS NULL → no-op na 2ª aplicação).
    expect(migration).toMatch(/UPDATE `bloqueios`/)
    expect(migration).toMatch(/SET `resolved_at` = NOW\(\)/)
    expect(migration).toMatch(/WHERE `resolved_at` IS NULL\s+AND `block_reason` LIKE 'setup_not_verified:%'/)
    expect(migration).not.toMatch(/DROP|ALTER TABLE|TRUNCATE/i)
    // O repositório não insere mais bloqueios 'setup_not_verified'.
    expect(repository).not.toContain('INSERT INTO bloqueios')
    expect(repository).toContain("'setup_not_verified'")
  })
})
