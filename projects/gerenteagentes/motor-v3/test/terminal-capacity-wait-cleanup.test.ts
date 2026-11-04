// @vitest-environment node
// task-p2-1059 — limpeza estrutural dos flags capacity_wait_* na transição
// terminal + guarda defensiva na projeção.
//
// Incidentes 1023/1047 (2026-11-03): flags obsoletos de espera de capacidade
// sobreviveram em task_runtime_facts após a tarefa chegar a estado terminal e
// o Mapa de agentes passou a exibir ampulheta em tarefa concluída/deployada.
//
// Cobertura:
// (a) limpeza das 8 colunas capacity_wait_* em cada caminho terminal
//     (conclusão via verified, conclusão analítica/no-code, veredito de
//     verificação, resolução externa, cancelamento, trigger de conclusão);
// (b) projeção (capacityWait do repositório) não emite espera para tarefa
//     terminal com flag residual + guarda no endpoint de detalhe (start.ts);
// (c) regressão: espera legítima em tarefa NÃO-terminal continua projetada
//     para os 5 reason codes.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository, type SubtaskExecutionContext } from '../src/execution/DevelopmentExecutionRepository.js'
import { MySqlTaskCoordinatorRepository, TaskCancelConsumer } from '../src/coordinator/index.js'
import { ExternalResolutionHandler } from '../src/monitor/ExternalResolutionHandler.js'
import { ensureCompletionTrigger } from '../src/db/ensureTriggers.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'
import type { Pool } from 'mysql2/promise'

const CAPACITY_WAIT_COLUMNS = [
  'capacity_wait_phase', 'capacity_wait_reason_code', 'capacity_wait_limit_scope',
  'capacity_wait_limit_value', 'capacity_wait_provider', 'capacity_wait_since',
  'capacity_wait_retry_at', 'capacity_wait_alert_at',
] as const

const REASON_CODES = ['global_limit', 'project_limit', 'provider_limit', 'model_cooldown', 'setup_not_verified'] as const

/** Normaliza espaços e exige as 8 colunas capacity_wait_* nullificadas no SQL. */
function expectClearsAllCapacityWaitColumns(sql: string): void {
  const normalized = String(sql).replace(/\s+/g, ' ')
  for (const column of CAPACITY_WAIT_COLUMNS) {
    expect(normalized, `SQL deveria limpar ${column}: ${normalized}`).toContain(`${column} = NULL`)
  }
}

function findTerminalFactsWrite(calls: Array<{ sql: string; params: unknown[] }>, terminal: string) {
  return calls.find(call =>
    /INSERT INTO task_runtime_facts/.test(call.sql) && call.sql.includes(terminal))
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Fake para completeVerification/completeNoCodeExecution (DevelopmentExecutionRepository). */
function developmentFakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const factsRow = {
    id: 963, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
    analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null,
    terminal_status: null, awaiting_interaction: 0, has_active_blocker: 0,
    deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0, active_monitor_fix: 0,
  }
  const connection = {
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const text = String(sql)
      if (/SELECT external_id FROM tarefas WHERE id = \?/.test(text)) return [[{ external_id: 'task-963' }]]
      if (/resource_wait_key/.test(text)) return [[factsRow]]
      if (/SELECT status, completion_kind, workspace_status FROM subtarefas/.test(text)) {
        return [[{ status: 'verified', completion_kind: 'code_change', workspace_status: 'integrated' }]]
      }
      if (/SELECT s\.id, s\.seq, s\.titulo, s\.scope/.test(text)) return [[]]
      if (/SELECT COUNT\(\*\) AS total\s+FROM subtarefas/.test(text)) return [[{ total: 0 }]]
      if (/FROM deploy_requests/.test(text) && /COUNT\(\*\)/.test(text)) return [[{ total: 0 }]]
      if (/FROM test_runs/.test(text)) return [[]]
      if (/FROM motor_execution_wait_queue/.test(text)) return [[]]
      if (/INSERT INTO deploy_requests/.test(text)) return [{ affectedRows: 1, insertId: 1 }]
      if (/^\s*(SELECT|SET|SHOW)/.test(text)) return [[]]
      return [{ affectedRows: 1, insertId: 1 }]
    }),
  }
  return { pool: { getConnection: vi.fn(async () => connection) } as unknown as Pool, calls, connection }
}

/** Fake para persistAnalysis (veredito de verificação → completed). */
function persistAnalysisFakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const text = String(sql)
      if (/SELECT t\.id, t\.tipo, t\.external_id, t\.projeto_id FROM tarefas/.test(text)) {
        return [[{ id: 5, tipo: 'verificacao', external_id: 'task-5', projeto_id: null }]]
      }
      if (/^\s*(SELECT|SET|SHOW)/.test(text)) return [[]]
      return [{ affectedRows: 1, insertId: 9 }]
    }),
  }
  return { pool: { getConnection: vi.fn(async () => connection), query: vi.fn(async () => [[], []]) } as unknown as Pool, calls, connection }
}

/** Fake do TaskCancelConsumer (padrão de test/task-cancel-consumer.test.ts). */
function cancelFakePool(taskRow: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    calls.push({ sql: text, params: params ?? [] })
    if (/SELECT t\.id, t\.external_id, f\.terminal_status/.test(text)) return [taskRow ? [taskRow] : []]
    if (/SELECT COUNT\(\*\) AS total FROM deploy_requests/.test(text)) return [[{ total: 0 }]]
    if (/^\s*(SELECT|SET|SHOW)/.test(text)) return [[]]
    return [{ affectedRows: 1, insertId: 1 }]
  })
  const connection = {
    query, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(),
  }
  return { pool: { query, getConnection: vi.fn(async () => connection) } as unknown as Pool, calls, connection }
}

/** Fake do ExternalResolutionHandler (padrão de test/external-resolution.test.ts). */
function externalResolutionFakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const text = String(sql)
      if (/SELECT t\.id, t\.external_id, t\.tipo/.test(text)) {
        return [[{ id: 820, external_id: 'task-p2-820', tipo: 'desenvolvimento' }]]
      }
      if (/SELECT id, subtarefa_id, block_reason FROM bloqueios/.test(text)) return [[]]
      if (/SUM\(status IN \('verified', 'superseded'\)\)/.test(text)) return [[{ total: 5, finais: 5 }]]
      if (/SELECT terminal_status FROM task_runtime_facts/.test(text)) return [[{ terminal_status: null }]]
      if (/Adjudicação administrativa sem deploy/.test(text) && /^\s*SELECT/.test(text.trim())) {
        return [[{ has_tombstone: 0 }]]
      }
      if (/^\s*(SELECT|SET|SHOW)/.test(text)) return [[]]
      return [{ affectedRows: 1, insertId: 1 }]
    }),
  }
  return { pool: { getConnection: vi.fn(async () => connection) } as unknown as Pool, calls, connection }
}

/** Fake para getTask (projeção do snapshot com capacityWait). */
function getTaskFakePool(row: Record<string, unknown>, facts: Record<string, unknown>) {
  const pool = {
    query: vi.fn(async (sql: string) => {
      const text = String(sql)
      if (/f\.capacity_wait_phase/.test(text) && /FROM tarefas t/.test(text)) return [[row]]
      if (/FROM tarefa_dependencias/.test(text)) return [[]]
      if (/resource_wait_key/.test(text)) return [[facts]]
      if (/SELECT status, completion_kind, workspace_status FROM subtarefas/.test(text)) return [[]]
      return [[]]
    }),
    getConnection: vi.fn(async () => { throw new Error('não esperado') }),
  } as unknown as Pool
  return new MySqlTaskCoordinatorRepository(pool)
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42, external_id: 'task-42', titulo: 'Tarefa', descricao: null, tipo: 'desenvolvimento',
    agente_id: 'agent-1', project_slug: 'gerenteagentes', repo_path: '/repo', paused_at: null,
    analysis_started_at: null, analysis_execution_id: null, projeto_id: 7, auto_start: 1,
    setup_status: 'verified', terminal_status: null, subtask_count: 0, blocked_count: 0,
    depends_on_task_id: null, dependency_external_id: null, dependency_id: null,
    dependency_tipo: null, dependency_terminal_status: null, dependency_deploy_status: null,
    capacity_wait_phase: null, capacity_wait_reason_code: null, capacity_wait_limit_scope: null,
    capacity_wait_limit_value: null, capacity_wait_provider: null, capacity_wait_retry_at: null,
    ...overrides,
  }
}

function factsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
    analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null,
    terminal_status: null, awaiting_interaction: 0, has_active_blocker: 0,
    deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0, active_monitor_fix: 0,
    ...overrides,
  }
}

const residualWait = {
  capacity_wait_phase: 'development', capacity_wait_reason_code: 'global_limit',
  capacity_wait_limit_scope: 'global', capacity_wait_limit_value: 3,
  capacity_wait_provider: null, capacity_wait_retry_at: new Date('2026-11-03T10:00:00Z'),
}

const context: SubtaskExecutionContext = {
  taskId: 'task-963', databaseTaskId: 963, projectId: 1, subtaskId: 2, seq: 2,
  taskTitle: 'Tarefa', taskDescription: '', title: 'Última subtarefa', scope: '',
  acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes', repoPath: '',
  baseBranch: 'base-desenvolvimento', buildCommand: '', testCommand: '', agentId: 'agent',
  workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
  completionKind: 'code_change', generation: 1,
}

const source: QueueMessage = {
  messageId: 'source-1', type: 'SUBTASK_EXECUTION_COMPLETED', taskId: 'task-963',
  executionId: 'exec-963', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
}

// ---------------------------------------------------------------------------
// (a) Limpeza das 8 colunas em cada transição terminal
// ---------------------------------------------------------------------------

describe('task-p2-1059 (a) — transições terminais limpam as 8 colunas capacity_wait_*', () => {
  it('conclusão via verified (completeVerification → task completed)', async () => {
    const fake = developmentFakePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.completeVerification(context, source, { commitSha: 'abc123', integrationCommitSha: 'def456' })

    const terminalWrite = findTerminalFactsWrite(fake.calls, "'completed'")
    expect(terminalWrite, 'escrita terminal de completeVerification').toBeDefined()
    expectClearsAllCapacityWaitColumns(terminalWrite!.sql)
    // Mesma transação: a escrita terminal acontece entre begin e commit da
    // mesma conexão (nunca em query solta fora da transação).
    expect(fake.connection.beginTransaction).toHaveBeenCalledOnce()
    expect(fake.connection.commit).toHaveBeenCalledOnce()
    expect(fake.connection.rollback).not.toHaveBeenCalled()
  })

  it('conclusão analítica/no-code (completeNoCodeExecution → task completed)', async () => {
    const fake = developmentFakePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.completeNoCodeExecution({ ...context, completionKind: 'analysis' }, source, 'análise concluída')

    const terminalWrite = findTerminalFactsWrite(fake.calls, "'completed'")
    expect(terminalWrite, 'escrita terminal de completeNoCodeExecution').toBeDefined()
    expectClearsAllCapacityWaitColumns(terminalWrite!.sql)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('veredito de verificação (persistAnalysis verification → completed)', async () => {
    const fake = persistAnalysisFakePool()
    const repository = new MySqlTaskCoordinatorRepository(fake.pool)

    await repository.persistAnalysis('task-5', 'exec-5', {
      kind: 'verification', verdict: 'approved', summary: 'Verificado', evidence: ['{}'],
    })

    const terminalWrite = findTerminalFactsWrite(fake.calls, "'completed'")
    expect(terminalWrite, 'escrita terminal do veredito').toBeDefined()
    expectClearsAllCapacityWaitColumns(terminalWrite!.sql)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('resolução externa (ExternalResolutionHandler → completed)', async () => {
    const fake = externalResolutionFakePool()
    const handler = new ExternalResolutionHandler(fake.pool)

    const result = await handler.handle({
      taskId: 'task-p2-820', motivo: 'Concluída externamente', resolvedBy: 'test',
    })

    expect(result.ok).toBe(true)
    expect(result.completed).toBe(true)
    const terminalWrite = findTerminalFactsWrite(fake.calls, "'completed'")
    expect(terminalWrite, 'escrita terminal da resolução externa').toBeDefined()
    expectClearsAllCapacityWaitColumns(terminalWrite!.sql)
    expect(fake.connection.commit).toHaveBeenCalled()
  })

  it('cancelamento (TaskCancelConsumer → cancelled) normalizado para as 8 colunas', async () => {
    const fake = cancelFakePool({ id: 862, external_id: 'task-p6-862', terminal_status: null })
    const consumer = new TaskCancelConsumer(fake.pool)

    await consumer.handle(createQueueMessage({
      type: 'TASK_CANCEL_REQUESTED', taskId: 'task-p6-862', executionId: 'task-p6-862', payload: {},
    }))

    const terminalWrite = findTerminalFactsWrite(fake.calls, "'cancelled'")
    expect(terminalWrite, 'escrita terminal do cancelamento').toBeDefined()
    expectClearsAllCapacityWaitColumns(terminalWrite!.sql)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('trigger trg_subtarefas_completion_net limpa as 8 colunas no ON DUPLICATE KEY UPDATE', async () => {
    const sqlCalls: string[] = []
    const connection = {
      query: vi.fn(async (sql: string) => {
        sqlCalls.push(String(sql))
        if (/GET_LOCK/.test(String(sql))) return [[{ acquired: 1 }]]
        if (/RELEASE_LOCK/.test(String(sql))) return [[{ 'RELEASE_LOCK(?, 30)': 1 }]]
        return [{ affectedRows: 0 }]
      }),
      release: vi.fn(),
    }
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool

    await expect(ensureCompletionTrigger(pool)).resolves.toBe(true)

    const create = sqlCalls.find(sql => sql.includes('CREATE TRIGGER'))
    expect(create).toBeDefined()
    const duplicateClause = create!.slice(create!.indexOf('ON DUPLICATE KEY UPDATE'))
    expectClearsAllCapacityWaitColumns(duplicateClause)
  })

  it('claim de análise normalizado: também nullifica since/retry_at/alert_at', async () => {
    // Padrão de test/setup-gate-capacity-wait.test.ts: setup verified → claim.
    const row = {
      id: 42, external_id: 'task-1', projeto_id: 7, paused_at: null, auto_start: 1,
      setup_status: 'verified', analysis_started_at: null, analysis_execution_id: null,
      terminal_status: null, subtask_count: 0, blocked_count: 0,
    }
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const connection = {
      beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}), release: vi.fn(),
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql: String(sql), params })
        const text = String(sql)
        if (text.includes('FOR UPDATE') && text.includes('FROM tarefas t')) return [[row]]
        if (text.includes('FROM motor_configuracoes')) {
          return [[{ chave: 'motor.max_workers', limite: 5 }, { chave: 'motor.max_workers_per_project', limite: 5 }]]
        }
        if (text.includes('COUNT(*) AS total')) return [[{ total: 0 }]]
        if (text.includes('project_model_selection')) return [[{ model: null, provider: null }]]
        if (text.includes('UPDATE task_runtime_facts') && text.includes('analysis_execution_id = ?')) return [{ affectedRows: 1 }]
        return [[]]
      }),
    }
    const repository = new MySqlTaskCoordinatorRepository({ getConnection: vi.fn(async () => connection) } as unknown as Pool)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe(true)

    const claim = calls.find(call => call.sql.includes('SET analysis_started_at = NOW()'))
    expect(claim).toBeDefined()
    expectClearsAllCapacityWaitColumns(claim!.sql)
  })
})

// ---------------------------------------------------------------------------
// (b) Guarda defensiva na projeção
// ---------------------------------------------------------------------------

describe('task-p2-1059 (b) — projeção nunca emite capacityWait para tarefa terminal', () => {
  it.each(['completed', 'cancelled', 'failed'])('capacityWait() retorna null para terminal_status=%s com flags residuais', async terminalStatus => {
    const repository = getTaskFakePool(
      taskRow({ terminal_status: terminalStatus, ...residualWait }),
      factsRow({ terminal_status: terminalStatus }),
    )

    const snapshot = await repository.getTask('task-42')

    expect(snapshot).not.toBeNull()
    expect(snapshot!.terminal).toBe(true)
    expect(snapshot!.capacityWait ?? null).toBeNull()
  })

  it('endpoint de detalhe (start.ts) busca terminal_status e guarda a projeção de capacityWait', async () => {
    // start.ts é o bootstrap do servidor (sem handler exportável); a assertsão
    // é no nível do contrato SQL/guarda, padrão usado em test/setup-gate-capacity-wait.test.ts.
    const startSource = await readFile(
      fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8',
    )
    const detailBlock = startSource.slice(startSource.indexOf('const [capacityWaitRows]'))
    expect(detailBlock).toContain('terminal_status AS terminalStatus')
    expect(detailBlock).toContain('terminalStatus == null')
  })

  it('pause (start.ts) nullifica as 8 colunas, incluindo since/retry_at/alert_at', async () => {
    const startSource = await readFile(
      fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8',
    )
    const pauseBlock = startSource.slice(startSource.indexOf('SET f.capacity_wait_phase = NULL'))
    const pauseSql = pauseBlock.slice(0, pauseBlock.indexOf('WHERE t.external_id'))
    for (const column of CAPACITY_WAIT_COLUMNS) {
      expect(pauseSql.replace(/\s+/g, ' ')).toContain(`f.${column} = NULL`)
    }
  })
})

// ---------------------------------------------------------------------------
// (c) Regressão — espera legítima em tarefa NÃO-terminal continua projetada
// ---------------------------------------------------------------------------

describe('task-p2-1059 (c) — regressão: espera legítima em tarefa ativa continua projetada', () => {
  it.each(REASON_CODES)('capacityWait projeta espera não-terminal para reason code %s', async reasonCode => {
    const limitScope = reasonCode === 'global_limit' ? 'global'
      : reasonCode === 'project_limit' ? 'project'
        : reasonCode === 'model_cooldown' ? 'model'
          : reasonCode === 'setup_not_verified' ? 'project'
            : 'provider'
    const repository = getTaskFakePool(
      taskRow({
        capacity_wait_phase: reasonCode === 'setup_not_verified' ? 'analysis' : 'development',
        capacity_wait_reason_code: reasonCode,
        capacity_wait_limit_scope: limitScope,
        capacity_wait_limit_value: 2,
        capacity_wait_provider: reasonCode === 'provider_limit' ? 'openai' : null,
        capacity_wait_retry_at: new Date('2026-11-05T10:00:00Z'),
      }),
      factsRow(),
    )

    const snapshot = await repository.getTask('task-42')

    expect(snapshot).not.toBeNull()
    expect(snapshot!.terminal).toBe(false)
    expect(snapshot!.capacityWait).toEqual({
      phase: reasonCode === 'setup_not_verified' ? 'analysis' : 'development',
      reasonCode,
      limitScope,
      limitValue: 2,
      provider: reasonCode === 'provider_limit' ? 'openai' : null,
      retryAt: '2026-11-05T10:00:00.000Z',
    })
  })

  it('gravação da espera legítima permanece intacta no caminho de desenvolvimento (enqueueCapacityWait)', async () => {
    // A limpeza terminal não pode tocar na gravação da espera: o UPDATE que
    // define capacity_wait_phase = 'development' continua existindo no
    // repositório de execução (claim/park de cooldown).
    const repositorySource = await readFile(
      fileURLToPath(new URL('../src/execution/DevelopmentExecutionRepository.ts', import.meta.url)), 'utf8',
    )
    expect(repositorySource).toContain("capacity_wait_phase = 'development', capacity_wait_reason_code = ?")
    expect(repositorySource).toContain('capacity_wait_since = IF(capacity_wait_reason_code <=> ?')
  })
})
