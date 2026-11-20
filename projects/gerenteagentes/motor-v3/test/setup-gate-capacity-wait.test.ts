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
import type { Pool } from 'mysql2/promise'
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

function connectionMock(row: Record<string, unknown>, projectRow: Record<string, unknown> | null = null) {
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
      if (sqlText.includes('FROM projetos_captados pc')) return [projectRow ? [projectRow] : [], []]
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
    const wait = calls.find(call => call.sql.includes('UPDATE task_runtime_facts') && call.sql.includes('capacity_wait_reason_code=?'))
    expect(wait).toBeDefined()
    expect(wait?.params).toEqual([
      'setup_not_verified', 'setup_not_verified',
      'analysis', 'setup_not_verified', 'project', 0, null,
      // Sem linha de projeto no mock → sub-motivo ausente (colunas null).
      null, null, null,
      42,
    ])
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

  it('sub-motivo rico: setup failed persiste setupState/setupError/detail nos flags capacity_wait_* (migration 0105)', async () => {
    const { connection, calls } = connectionMock(
      lockedRow({ setup_status: 'failed' }),
      {
        slug: 'gestao-de-tarefas-global',
        setup_status: 'failed',
        setup_error: 'Setup reprovado: artefato ausente',
        geracoes_ativas: 0,
        ultima_geracao_status: 'completed',
        ultima_geracao_erro: null,
        setup_redispatch_count: 0,
        setup_redispatch_last_at: null,
      },
    )
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe('capacity_waiting')

    const wait = calls.find(call => call.sql.includes('UPDATE task_runtime_facts') && call.sql.includes('capacity_wait_setup_state=?'))
    expect(wait).toBeDefined()
    expect(wait!.sql).toContain('capacity_wait_since = IF(capacity_wait_reason_code <=> ?')
    expect(wait?.params).toEqual([
      'setup_not_verified', 'setup_not_verified',
      'analysis', 'setup_not_verified', 'project', 0, null,
      'setup_failed', 'Setup reprovado: artefato ausente', expect.stringContaining('FALHOU'),
      42,
    ])
  })

  it('sub-motivo setup_failed com contador de re-disparo no teto: detalhe expõe tentativa X de Y', async () => {
    const { connection, calls } = connectionMock(
      lockedRow({ setup_status: 'failed' }),
      {
        slug: 'consoleopenclaw',
        setup_status: 'failed',
        setup_error: null,
        geracoes_ativas: 0,
        ultima_geracao_status: null,
        ultima_geracao_erro: null,
        setup_redispatch_count: 2,
        setup_redispatch_last_at: new Date('2026-11-20T17:00:00Z'),
      },
    )
    const repository = repositoryWith(connection)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe('capacity_waiting')

    const wait = calls.find(call => call.sql.includes('capacity_wait_setup_state=?'))
    expect(wait?.params[7]).toBe('setup_failed')
    expect(wait?.params[9]).toContain('tentativa 3 de 3')
  })

  it('projeção capacityWait expõe setupState/setupError/detail quando presentes (GET /api/motor/task/:id)', async () => {
    const repository = new MySqlTaskCoordinatorRepository({
      getConnection: vi.fn(),
      query: vi.fn(async (sql: string) => {
        const text = String(sql)
        if (text.includes('f.capacity_wait_setup_state') && text.includes('FROM tarefas t')) {
          return [[{
            id: 42, external_id: 'task-1', titulo: 't', descricao: null, tipo: 'desenvolvimento',
            repo_path: null, project_layout: 'monorepo', paused_at: null, auto_start: 1,
            setup_status: 'failed', analysis_started_at: null, analysis_execution_id: null,
            projeto_id: 7, terminal_status: null, subtask_count: 0, blocked_count: 0,
            project_slug: 'gestao-de-tarefas-global', agente_id: 'a',
            capacity_wait_phase: 'analysis', capacity_wait_reason_code: 'setup_not_verified',
            capacity_wait_limit_scope: 'project', capacity_wait_limit_value: 0,
            capacity_wait_provider: null, capacity_wait_retry_at: null,
            capacity_wait_setup_state: 'setup_failed',
            capacity_wait_setup_error: 'artefato ausente',
            capacity_wait_detail: "setup do projeto 'gestao-de-tarefas-global' FALHOU",
          }], []]
        }
        if (text.includes('resource_wait_key')) {
          return [[{
            id: 42, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
            analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null,
            terminal_status: null, awaiting_interaction: 0, has_active_blocker: 0,
            deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0, active_monitor_fix: 0,
          }], []]
        }
        return [[], []]
      }),
    } as unknown as Pool)

    const snapshot = await repository.getTask('task-1')
    expect(snapshot!.capacityWait).toMatchObject({
      reasonCode: 'setup_not_verified',
      setupState: 'setup_failed',
      setupError: 'artefato ausente',
      detail: "setup do projeto 'gestao-de-tarefas-global' FALHOU",
    })
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
