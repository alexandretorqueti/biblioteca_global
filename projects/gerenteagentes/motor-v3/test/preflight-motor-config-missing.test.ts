// @vitest-environment node
// Incidente 27/11 (projeto 16 vitrine-ia, tarefa 1138, bloqueio 3568): projeto
// sem linha em `projeto_motor_config` morria no preflight do Analista com
// 'repo_inacessivel: repoPath/workspace vazio' genérico, queimando as 3
// tentativas como analysis_failed e poluindo o setup_status. Esta suíte cobre
// o diagnóstico explícito ('projeto_motor_config ausente para projeto_id=X'),
// o bloqueio dedicado 'setup_faltando' com TASK_BLOCKED no outbox do Monitor,
// a preservação de setup_status e a não-regressão do caminho repo_inacessivel.
import { describe, expect, it, vi } from 'vitest'
import { ConsoleAnalystRunner, type AnalystConsole } from '../src/analysis/ConsoleAnalystRunner.js'
import { MySqlAnalysisFailureBlocker } from '../src/coordinator/AnalysisFailureBlocker.js'
import { MySqlTaskCoordinatorRepository } from '../src/coordinator/MySqlTaskCoordinatorRepository.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import { MessageBus } from '../src/bus/MessageBus.js'
import { createQueueMessage } from '../src/queue/index.js'

const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  taskId: 'task-p2-1138', title: 'Tarefa', description: 'Descrição', taskType: 'desenvolvimento',
  agentId: 'analista', projectSlug: 'vitrine-ia', repoPath: '', status: 'planned', paused: false,
  terminal: false, analysisStartedAt: null, subtaskCount: 0, ...overrides,
})

function consoleFake(): AnalystConsole {
  return {
    createSession: vi.fn(async () => { throw new Error('createSession não deveria ser chamado: preflight deve falhar antes') }),
    sendMessage: vi.fn(async () => {}),
    getSessionStatus: vi.fn(async () => ({ isComplete: true })),
  }
}

describe('MySqlTaskCoordinatorRepository — projeção projeto_id/motor_config_present', () => {
  const taskRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1138, external_id: 'task-p2-1138', titulo: 'Tarefa', descricao: 'Descrição', tipo: 'desenvolvimento',
    repo_path: '', project_layout: 'monorepo', paused_at: null, auto_start: 1, setup_status: 'verified',
    projeto_id: 16, motor_config_present: 0, agente_id: 'analista', project_slug: 'vitrine-ia',
    analysis_started_at: null, analysis_execution_id: null, terminal_status: null,
    subtask_count: 0, blocked_count: 0, depends_on_task_id: null,
    dependency_external_id: null, dependency_id: null, dependency_tipo: null,
    dependency_terminal_status: null, dependency_deploy_status: null,
    capacity_wait_phase: null, capacity_wait_reason_code: null, capacity_wait_limit_scope: null,
    capacity_wait_limit_value: null, capacity_wait_provider: null, capacity_wait_retry_at: null,
    capacity_wait_setup_state: null, capacity_wait_setup_error: null, capacity_wait_detail: null,
    ...overrides,
  })

  function repositoryWith(row: Record<string, unknown> | null) {
    const sqls: string[] = []
    const query = vi.fn(async (sql: string) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      sqls.push(normalized)
      if (normalized.includes('pmc.id IS NOT NULL AS motor_config_present') && normalized.includes('t.titulo')) {
        return [row ? [row] : [], []]
      }
      return [[], []]
    })
    const pool = {
      query,
      getConnection: vi.fn(async () => ({
        beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query,
      })),
    }
    return { repository: new MySqlTaskCoordinatorRepository(pool as never), sqls }
  }

  it('getTask projeta motorConfigPresent=false e projetoId quando não há linha em projeto_motor_config', async () => {
    const { repository } = repositoryWith(taskRow({ motor_config_present: 0 }))

    const snapshotValue = await repository.getTask('task-p2-1138')

    expect(snapshotValue).not.toBeNull()
    expect(snapshotValue!.motorConfigPresent).toBe(false)
    expect(snapshotValue!.projetoId).toBe(16)
  })

  it('getTask projeta motorConfigPresent=true quando a linha existe', async () => {
    const { repository } = repositoryWith(taskRow({ motor_config_present: 1, repo_path: '/data/workspace/projects/codigofonte/biblioteca-global' }))

    const snapshotValue = await repository.getTask('task-p2-1138')

    expect(snapshotValue!.motorConfigPresent).toBe(true)
    expect(snapshotValue!.projetoId).toBe(16)
  })

  it('SELECTs do getTask e do claim (lockTask) projetam a presença da config', async () => {
    const { repository, sqls } = repositoryWith(taskRow({ motor_config_present: 1 }))
    await repository.getTask('task-p2-1138')

    const mainSelect = sqls.find(sql => sql.includes('t.titulo'))
    expect(mainSelect).toContain('pmc.id IS NOT NULL AS motor_config_present')
    expect(mainSelect).toContain('t.projeto_id')

    const repository2 = repositoryWith(taskRow({ motor_config_present: 1 }))
    await repository2.repository.claimAnalysis('task-p2-1138', 'exec-1').catch(() => undefined)
    const lockSelect = repository2.sqls.find(sql => sql.includes('FOR UPDATE') && sql.includes('FROM tarefas t'))
    expect(lockSelect).toBeDefined()
    expect(lockSelect).toContain('pmc.id IS NOT NULL AS motor_config_present')
  })
})

describe('ConsoleAnalystRunner.preflightWorkspace — config do motor ausente', () => {
  it('motorConfigPresent=false e repoPath vazio: erro menciona projeto_motor_config ausente + projeto_id, sem repo_inacessivel', async () => {
    const consoleApi = consoleFake()
    const runner = new ConsoleAnalystRunner(consoleApi, {
      workspacePreflight: true,
      workspacePathMapper: () => null,
    })

    const error = await runner.start(snapshot({ motorConfigPresent: false, projetoId: 16 }), 'exec-1138')
      .then(() => null, (caught: unknown) => caught as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('project_setup_preflight_failed:')
    expect(error!.message).toContain('projeto_motor_config ausente para projeto_id=16')
    expect(error!.message).toContain('(registrar config do motor)')
    expect(error!.message).not.toContain('repo_inacessivel')
    // Nenhuma sessão é criada: o falhanço é anterior ao Console.
    expect(consoleApi.createSession).not.toHaveBeenCalled()
  })

  it('linha existente (motorConfigPresent=true) com repoPath vazio preserva repo_inacessivel (sem regressão)', async () => {
    const runner = new ConsoleAnalystRunner(consoleFake(), {
      workspacePreflight: true,
      workspacePathMapper: () => null,
    })

    await expect(runner.start(snapshot({ motorConfigPresent: true, projetoId: 16 }), 'exec-1138'))
      .rejects.toThrow('repo_inacessivel: repoPath/workspace vazio')
  })

  it('snapshot legado sem motorConfigPresent mantém o comportamento antigo (repo_inacessivel)', async () => {
    const runner = new ConsoleAnalystRunner(consoleFake(), {
      workspacePreflight: true,
      workspacePathMapper: () => null,
    })

    await expect(runner.start(snapshot({ repoPath: '' }), 'exec-1138'))
      .rejects.toThrow('repo_inacessivel: repoPath/workspace vazio')
  })
})

describe('TaskCoordinator — classificação setup_faltando sem tocar setup_status', () => {
  function setup(snapshotValue: TaskSnapshot | null) {
    const repository: TaskCoordinatorRepository = {
      getTask: vi.fn(async () => snapshotValue),
      claimAnalysis: vi.fn(async () => true),
      releaseAnalysisClaim: vi.fn(async () => {}),
      persistAnalysis: vi.fn(async () => {}),
    }
    const runner = { start: vi.fn(async () => { throw new Error('unexpected') }) }
    const analysisFailure = {
      blockForAnalysisFailure: vi.fn(async () => {}),
      recordProjectSetupFailure: vi.fn(async () => {}),
    }
    const coordinator = new TaskCoordinator(repository, runner, new MessageBus(), {
      analysisFailure,
      maxAnalysisAttempts: 3,
    })
    const message = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED', taskId: snapshotValue?.taskId ?? 'task-1',
      executionId: 'source-exec', payload: {}, attempt: 3,
    })
    return { repository, runner, analysisFailure, coordinator, message }
  }

  it('erro com marcador projeto_motor_config ausente: bloqueio setup_faltando na tentativa final e NENHUM recordProjectSetupFailure', async () => {
    const { runner, analysisFailure, coordinator, message } = setup(snapshot({ motorConfigPresent: false, projetoId: 16 }))
    vi.mocked(runner.start).mockRejectedValue(new Error(
      'project_setup_preflight_failed: projeto_motor_config ausente para projeto_id=16 (registrar config do motor)',
    ))

    await expect(coordinator.handle(message)).rejects.toThrow('projeto_motor_config ausente')

    expect(analysisFailure.recordProjectSetupFailure).not.toHaveBeenCalled()
    expect(analysisFailure.blockForAnalysisFailure).toHaveBeenCalledWith(
      'task-p2-1138',
      expect.objectContaining({ attempt: 3, error: expect.stringContaining('projeto_motor_config ausente') }),
      'setup_faltando',
    )
  })

  it('erro repo_inacessivel (linha existente): comportamento preservado — sem setup_failed, bloqueio com razão default', async () => {
    const { runner, analysisFailure, coordinator, message } = setup(snapshot({ motorConfigPresent: true, projetoId: 16 }))
    vi.mocked(runner.start).mockRejectedValue(new Error(
      'project_setup_preflight_failed: projeto sem setup concluído (repo_inacessivel: repoPath/workspace vazio)',
    ))

    await expect(coordinator.handle(message)).rejects.toThrow('repo_inacessivel')

    expect(analysisFailure.recordProjectSetupFailure).not.toHaveBeenCalled()
    expect(analysisFailure.blockForAnalysisFailure).toHaveBeenCalledWith(
      'task-p2-1138',
      expect.objectContaining({ attempt: 3 }),
      undefined,
    )
  })

  it('tentativa transitória com marcador não bloqueia (semântica de tentativas preservada)', async () => {
    const { runner, analysisFailure, coordinator } = setup(snapshot({ motorConfigPresent: false, projetoId: 16 }))
    vi.mocked(runner.start).mockRejectedValue(new Error(
      'project_setup_preflight_failed: projeto_motor_config ausente para projeto_id=16 (registrar config do motor)',
    ))
    const message = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED', taskId: 'task-p2-1138', executionId: 'source-exec',
      payload: {}, attempt: 1,
    })

    await expect(coordinator.handle(message)).rejects.toThrow('projeto_motor_config ausente')

    expect(analysisFailure.blockForAnalysisFailure).not.toHaveBeenCalled()
    expect(analysisFailure.recordProjectSetupFailure).not.toHaveBeenCalled()
  })
})

interface BlockerQuery { sql: string; params: unknown[] }

function blockerFake(opts: { insertAffectedRows?: number } = {}) {
  const queries: BlockerQuery[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.startsWith('INSERT INTO bloqueios')) return [{ affectedRows: opts.insertAffectedRows ?? 1 }]
    if (normalized.startsWith('SELECT b.id, b.tarefa_id FROM bloqueios')) return [[{ id: 3569, tarefa_id: 16 }]]
    if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
    return [[]]
  })
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query,
  }
  const pool = { getConnection: vi.fn(async () => connection) } as never
  return { blocker: new MySqlAnalysisFailureBlocker(pool), queries, connection }
}

const failureInfo = {
  executionId: 'exec-analyze-task-1138',
  attempt: 3,
  error: 'project_setup_preflight_failed: projeto_motor_config ausente para projeto_id=16 (registrar config do motor)',
}

describe('MySqlAnalysisFailureBlocker — blockReason parametrizável', () => {
  it("bloqueio 'setup_faltando': INSERT com razão dedicada, dedupe NOT EXISTS pela mesma razão e TASK_BLOCKED no outbox motor.monitor na mesma transação", async () => {
    const fake = blockerFake()

    await fake.blocker.blockForAnalysisFailure('1138', failureInfo, 'setup_faltando')

    const insert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(insert).toBeDefined()
    // Razão parametrizada no valor do INSERT e no NOT EXISTS (dedupe por razão).
    expect(insert!.params.filter(p => p === 'setup_faltando')).toHaveLength(2)
    expect(insert!.sql).toContain('b.block_reason = ?')
    expect(insert!.params).toContain('TASK_RESUME_REQUESTED')
    expect(insert!.params).toContain('1138')

    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeDefined()
    expect(monitorOutbox!.params).toContain('TASK_BLOCKED')
    const payload = JSON.parse(String(monitorOutbox!.params.find(p => String(p).startsWith('{'))))
    expect(payload).toMatchObject({ blockReason: 'setup_faltando' })
    expect(payload.blockExcerpt).toContain('projeto_motor_config ausente para projeto_id=16')

    // INSERT e outbox na MESMA transação.
    expect(fake.connection.commit).toHaveBeenCalledOnce()
    expect(fake.connection.rollback).not.toHaveBeenCalled()
  })

  it('sem blockReason: default analysis_failed preservado (sem regressão)', async () => {
    const fake = blockerFake()

    await fake.blocker.blockForAnalysisFailure('1138', { executionId: 'exec-1', attempt: 3, error: 'Console indisponível' })

    const insert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(insert!.params.filter(p => p === 'analysis_failed')).toHaveLength(2)
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    const payload = JSON.parse(String(monitorOutbox!.params.find(p => String(p).startsWith('{'))))
    expect(payload).toMatchObject({ blockReason: 'analysis_failed' })
  })

  it('bloqueio ativo da mesma razão (redelivery): não duplica linha nem TASK_BLOCKED', async () => {
    const fake = blockerFake({ insertAffectedRows: 0 })

    await fake.blocker.blockForAnalysisFailure('1138', failureInfo, 'setup_faltando')

    const blockIdSelect = fake.queries.find(q => q.sql.startsWith('SELECT b.id, b.tarefa_id FROM bloqueios'))
    expect(blockIdSelect).toBeUndefined()
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeUndefined()
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('taskId não numérico usa apenas external_id no WHERE e parametriza a razão', async () => {
    const fake = blockerFake()

    await fake.blocker.blockForAnalysisFailure('task-p2-1138', failureInfo, 'setup_faltando')

    const insert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(insert!.sql).toContain('t.external_id = ?')
    expect(insert!.params.filter(p => p === 'setup_faltando')).toHaveLength(2)
    expect(insert!.params).toContain('task-p2-1138')
  })
})
