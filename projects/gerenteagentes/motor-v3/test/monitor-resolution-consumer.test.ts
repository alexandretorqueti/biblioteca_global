import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MonitorResolutionConsumer, TASK_BLOCKED_EVENT_TYPE } from '../src/monitor/index.js'
import type { MonitorPromptMarkers } from '../src/monitor/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

const BLOCKER_ROW = {
  id: 45, tarefa_id: 886, subtarefa_id: null,
  block_reason: 'deploy_failed', block_command: 'motor-v3:deploy:batch-1',
  block_excerpt: 'script blue-green informou falha',
}

const CONTEXT_ROW = {
  database_task_id: 886, task_id: 'task-p1-886', titulo: 'Conexão MySQL por projeto',
  projeto_id: 1, project_slug: 'biblioteca-global', repo_path: '/repo/biblioteca-global',
  branch_trabalho: 'base-desenvolvimento', build_command: 'npm run build',
  unit_test_command: 'npm test', agent_id: 'bibliotecaglobal',
}

const VEREDITO_RESOLVIDO = [
  'STATUS: RESOLVIDO',
  'ORIGEM: MOTOR',
  '',
  'CAUSA:',
  'Migration 0005 com sintaxe inválida.',
  '',
  'MENSAGEM_CHAT:',
  'O deploy falhou por erro na migration. Corrigi o motor e refiz o deploy.',
].join('\n')

interface FakeOptions {
  blocker?: typeof BLOCKER_ROW | null
  context?: typeof CONTEXT_ROW | null
  models?: string[]
  devBranches?: string[]
  workerResult?: { success: boolean; response?: string; error?: string; attempts?: number; model?: string }
  workerError?: Error
  unblockAffectedRows?: number
}

function fakeEnvironment(options: FakeOptions = {}) {
  const queries: { sql: string; params: unknown[]; via: 'pool' | 'connection' }[] = []
  const record = (via: 'pool' | 'connection') => async (sql: string, params?: unknown[]) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params: params ?? [], via })
    if (normalized.includes('FROM bloqueios b')) {
      const blocker = options.blocker === undefined ? BLOCKER_ROW : options.blocker
      return [blocker ? [blocker] : [], []]
    }
    if (normalized.includes('FROM tarefas t') && normalized.includes('projetos_captados')) {
      const context = options.context === undefined ? CONTEXT_ROW : options.context
      return [context ? [context] : [], []]
    }
    if (normalized.includes('project_model_selection')) {
      return [(options.models ?? ['gpt-5.6-sol']).map(model => ({ model })), []]
    }
    if (normalized.includes('FROM subtarefas')) {
      return [(options.devBranches ?? ['motor-v3-work/subtask-task-p1-886-1184-a1']).map(workspace_branch => ({ workspace_branch })), []]
    }
    if (normalized.includes('UPDATE bloqueios SET resolved_at')) {
      return [{ affectedRows: options.unblockAffectedRows ?? 1 }, []]
    }
    return [{ affectedRows: 1 }, []]
  }
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(record('connection')),
  }
  const pool = {
    query: vi.fn(record('pool')),
    getConnection: vi.fn(async () => connection),
  } as unknown as Pool

  const prepareIntegration = vi.fn(async () => ({
    path: '/worktrees/task-p1-886/integration',
    branch: 'motor-v3-work/integration-task-p1-886',
    baseCommit: 'abc123',
    integrationPath: '/worktrees/task-p1-886/integration',
    integrationBranch: 'motor-v3-work/integration-task-p1-886',
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worktrees = { prepareIntegration } as any

  const executeTask = vi.fn(async () => ({
    success: options.workerResult?.success ?? true,
    response: options.workerResult?.response ?? VEREDITO_RESOLVIDO,
    error: options.workerResult?.error,
    attempts: options.workerResult?.attempts ?? 1,
    model: options.workerResult?.model ?? 'gpt-5.6-sol',
  }))
  if (options.workerError) executeTask.mockRejectedValueOnce(options.workerError)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = { executeTask } as any

  const resolve = vi.fn(async (_taskId: string, markers: MonitorPromptMarkers) => ({
    text: `prompt-renderizado ${markers.taskId}`,
    promptId: 11, versionId: 50, executionRowId: 99,
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prompts = { resolve } as any

  const events: Array<{ taskId: string; evento: string; payload: unknown }> = []
  const eventsSink = { record: vi.fn(async (taskId: string, evento: string, _ator?: string, payload?: unknown) => { events.push({ taskId, evento, payload }) }) }

  const notifier = { notify: vi.fn(async () => {}) }
  const consumer = new MonitorResolutionConsumer(pool, worktrees, worker, prompts, eventsSink, undefined, undefined, notifier)
  const chats = () => queries
    .filter(q => q.sql.includes('INSERT INTO tarefa_chats'))
    .map(q => ({ databaseTaskId: q.params[0], texto: String(q.params[1]) }))
  const outbox = (type: string) => queries.filter(q => q.sql.includes('INSERT INTO motor_outbox') && q.params[1] === type)
  return { consumer, pool, connection, queries, chats, outbox, worktrees, prepareIntegration, worker, executeTask, prompts, resolve, events, eventsSink, notifier }
}

function blockedMessage(overrides: Partial<QueueMessage> & { payload?: Record<string, unknown> } = {}): QueueMessage {
  return createQueueMessage({
    type: TASK_BLOCKED_EVENT_TYPE,
    taskId: 'task-p1-886',
    executionId: 'exec-block-1',
    payload: { blockReason: 'deploy_failed', batchId: 'batch-1', databaseTaskId: 886, ...overrides.payload },
    ...overrides,
  })
}

describe('MonitorResolutionConsumer', () => {
  it('ignora mensagens que não são TASK_BLOCKED', async () => {
    const env = fakeEnvironment()
    const other = createQueueMessage({ type: 'DEPLOY_BATCH_FAILED', taskId: 'task-p1-886', executionId: 'e', payload: {} })

    await env.consumer.handle(other)

    expect(env.executeTask).not.toHaveBeenCalled()
    expect(env.pool.query).not.toHaveBeenCalled()
  })

  it('não age quando o bloqueio já foi resolvido (idempotente em redelivery)', async () => {
    const env = fakeEnvironment({ blocker: null })

    await env.consumer.handle(blockedMessage())

    expect(env.executeTask).not.toHaveBeenCalled()
    expect(env.events).toHaveLength(0)
    expect(env.chats()).toHaveLength(0)
  })

  it('executa a missão com prompt resolvido, workspace de integração e modelos MONITOR', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(blockedMessage())

    // Workspace: worktree de integração da tarefa (reaproveita o existente)
    expect(env.prepareIntegration).toHaveBeenCalledWith({
      taskId: 'task-p1-886', repoPath: '/repo/biblioteca-global', baseBranch: 'base-desenvolvimento',
    })
    // Prompt: marcadores alimentados com bloqueio + contexto
    expect(env.resolve).toHaveBeenCalledOnce()
    const markers = env.resolve.mock.calls[0][1] as MonitorPromptMarkers
    expect(markers).toMatchObject({
      taskId: 'task-p1-886',
      taskTitle: 'Conexão MySQL por projeto',
      repository: '/repo/biblioteca-global',
      baseBranch: 'base-desenvolvimento',
      devBranch: 'motor-v3-work/subtask-task-p1-886-1184-a1',
      integrationBranch: 'motor-v3-work/integration-task-p1-886',
      workspace: '/worktrees/task-p1-886/integration',
      blockReason: 'deploy_failed',
      blockCommand: 'motor-v3:deploy:batch-1',
      evidence: 'script blue-green informou falha',
    })
    // Worker: prompt renderizado + cadeia MONITOR + allowNoChanges
    expect(env.executeTask).toHaveBeenCalledOnce()
    const [context, promptText, models, , , allowNoChanges] = env.executeTask.mock.calls[0]
    expect(promptText).toBe('prompt-renderizado task-p1-886')
    expect(models).toEqual(['gpt-5.6-sol'])
    expect(allowNoChanges).toBe(true)
    expect(context).toMatchObject({
      taskId: 'task-p1-886', databaseTaskId: 886, projectSlug: 'biblioteca-global',
      repoPath: '/repo/biblioteca-global', worktreePath: '/worktrees/task-p1-886/integration',
      branchName: 'motor-v3-work/integration-task-p1-886', baseCommitSha: 'abc123',
      agentId: 'bibliotecaglobal', executionId: 'exec-block-1',
    })
    // Auditoria: started + finished + unblocked (veredito RESOLVIDO)
    expect(env.events.map(e => e.evento)).toEqual([
      'monitor_resolution_started', 'monitor_resolution_finished', 'monitor_resolution_unblocked',
    ])
    expect(env.events[1].payload).toMatchObject({ blockId: 45, success: true })
  })

  it('registra skipped e não executa quando não há modelos MONITOR habilitados', async () => {
    const env = fakeEnvironment({ models: [] })

    await env.consumer.handle(blockedMessage())

    expect(env.executeTask).not.toHaveBeenCalled()
    expect(env.events).toHaveLength(1)
    expect(env.events[0].evento).toBe('monitor_resolution_skipped')
    expect(env.events[0].payload).toMatchObject({ reason: 'sem_modelos_monitor' })
  })

  it('registra skipped quando a tarefa não é encontrada', async () => {
    const env = fakeEnvironment({ context: null })

    await env.consumer.handle(blockedMessage())

    expect(env.executeTask).not.toHaveBeenCalled()
    expect(env.events[0].evento).toBe('monitor_resolution_skipped')
    expect(env.events[0].payload).toMatchObject({ reason: 'tarefa_nao_encontrada' })
  })

  it('não executa duas vezes o mesmo blockId concorrentemente (guarda in-flight)', async () => {
    const env = fakeEnvironment()
    let resolveWorker: (value: unknown) => void = () => {}
    env.executeTask.mockImplementationOnce(() => new Promise(resolve => { resolveWorker = resolve }) as never)

    const first = env.consumer.handle(blockedMessage())
    // Aguarda a primeira missão chegar ao worker (guarda in-flight já armado)
    await vi.waitFor(() => expect(env.executeTask).toHaveBeenCalledOnce())

    // Segunda entrega do mesmo bloqueio: guardada por in-flight, não executa
    await env.consumer.handle(blockedMessage())
    expect(env.executeTask).toHaveBeenCalledOnce()

    resolveWorker({ success: true, attempts: 1, model: 'gpt-5.6-sol', response: VEREDITO_RESOLVIDO })
    await first
  })

  it('libera o guarda in-flight após a conclusão, permitindo nova execução', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(blockedMessage())
    await env.consumer.handle(blockedMessage())

    expect(env.executeTask).toHaveBeenCalledTimes(2)
  })

  it('usa blockId do payload para localizar o bloqueio ativo', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(blockedMessage({ payload: { blockId: 45, blockReason: 'deploy_failed' } }))

    const byId = env.queries.find(q => q.sql.includes('WHERE b.id = ?'))
    expect(byId).toBeDefined()
    expect(byId!.params[0]).toBe(45)
  })
})

describe('MonitorResolutionConsumer — chat da tarefa e desbloqueio (etapa 4)', () => {
  it('posta mensagem no chat ao iniciar a investigação', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(blockedMessage())

    const chats = env.chats()
    expect(chats.length).toBeGreaterThanOrEqual(1)
    expect(chats[0].databaseTaskId).toBe(886)
    expect(chats[0].texto).toContain('🔧 Monitor: investigando bloqueio `deploy_failed`')
    expect(chats[0].texto).toContain('script blue-green informou falha')
  })

  it('veredito RESOLVIDO desbloqueia, emite TASK_UNBLOCKED na mesma transação e posta resolução no chat', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(blockedMessage())

    // Desbloqueio: UPDATE resolved_at via conexão transacional
    const update = env.queries.find(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))
    expect(update).toBeDefined()
    expect(update!.via).toBe('connection')
    expect(update!.params).toEqual([45])
    expect(env.connection.commit).toHaveBeenCalled()

    // TASK_UNBLOCKED no outbox, na mesma transação do resolved_at
    const unblockedEvents = env.outbox('TASK_UNBLOCKED')
    expect(unblockedEvents).toHaveLength(1)
    expect(unblockedEvents[0].via).toBe('connection')
    const payload = JSON.parse(unblockedEvents[0].params[5] as string)
    expect(payload).toMatchObject({
      blockId: 45, blockReason: 'deploy_failed', databaseTaskId: 886,
      verdictStatus: 'RESOLVIDO', verdictOrigin: 'MOTOR', resolvedBy: 'monitor',
    })

    // Chat: mensagem de resolução com MENSAGEM_CHAT do veredito
    const resolutionChat = env.chats().find(chat => chat.texto.includes('✅'))
    expect(resolutionChat).toBeDefined()
    expect(resolutionChat!.texto).toContain('resolvido (origem: MOTOR)')
    expect(resolutionChat!.texto).toContain('Corrigi o motor e refiz o deploy')

    // Auditoria
    expect(env.events.map(e => e.evento)).toContain('monitor_resolution_unblocked')
    const unblockedRecord = env.events.find(e => e.evento === 'monitor_resolution_unblocked')
    expect(unblockedRecord!.payload).toMatchObject({ blockId: 45, origin: 'MOTOR', unblocked: true })
    // Bloqueio resolvido: humano NÃO é notificado
    expect(env.notifier.notify).not.toHaveBeenCalled()
  })

  it('veredito NAO_RESOLVIDO mantém o bloqueio e posta explicação no chat', async () => {
    const env = fakeEnvironment({
      workerResult: {
        success: true,
        response: [
          'STATUS: NAO_RESOLVIDO',
          'ORIGEM: EXTERNO',
          'CAUSA: DbaaS remoto fora do ar',
          'RETOMADA: reexecutar o deploy quando o banco externo voltar',
          'MENSAGEM_CHAT: O banco externo está indisponível; nada a corrigir no código.',
        ].join('\n'),
      },
    })

    await env.consumer.handle(blockedMessage())

    expect(env.queries.some(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))).toBe(false)
    expect(env.outbox('TASK_UNBLOCKED')).toHaveLength(0)
    const chat = env.chats().find(c => c.texto.includes('⚠️'))
    expect(chat).toBeDefined()
    expect(chat!.texto).toContain('NÃO resolvido completamente (status: NAO_RESOLVIDO, origem: EXTERNO)')
    expect(chat!.texto).toContain('banco externo está indisponível')
    expect(chat!.texto).toContain('Retomada: reexecutar o deploy')
    expect(env.events.map(e => e.evento)).toContain('monitor_resolution_kept_blocked')
    // Humano notificado quando o Monitor não resolve
    expect(env.notifier.notify).toHaveBeenCalledOnce()
    expect(env.notifier.notify.mock.calls[0][0]).toMatchObject({ taskId: 'task-p1-886', blockReason: 'deploy_failed' })
  })

  it('veredito PARCIALMENTE_RESOLVIDO mantém o bloqueio (conservador)', async () => {
    const env = fakeEnvironment({
      workerResult: { success: true, response: 'STATUS: PARCIALMENTE_RESOLVIDO\nORIGEM: DEV\nMENSAGEM_CHAT: corrigi parte, falta validação humana.' },
    })

    await env.consumer.handle(blockedMessage())

    expect(env.queries.some(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))).toBe(false)
    expect(env.chats().some(c => c.texto.includes('⚠️'))).toBe(true)
    expect(env.events.map(e => e.evento)).toContain('monitor_resolution_kept_blocked')
  })

  it('resposta fora do contrato mantém o bloqueio e explica no chat', async () => {
    const env = fakeEnvironment({ workerResult: { success: true, response: 'Acho que funcionou!' } })

    await env.consumer.handle(blockedMessage())

    expect(env.queries.some(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))).toBe(false)
    const kept = env.events.find(e => e.evento === 'monitor_resolution_kept_blocked')
    expect(kept!.payload).toMatchObject({ status: 'NAO_RESOLVIDO', parseable: false })
    expect(env.chats().some(c => c.texto.includes('não seguiu o contrato de veredito'))).toBe(true)
  })

  it('worker sem sucesso posta falha no chat e mantém o bloqueio', async () => {
    const env = fakeEnvironment({ workerResult: { success: false, error: 'timeout após 3 tentativas', attempts: 3 } })

    await env.consumer.handle(blockedMessage())

    expect(env.queries.some(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))).toBe(false)
    const chat = env.chats().find(c => c.texto.includes('❌'))
    expect(chat).toBeDefined()
    expect(chat!.texto).toContain('timeout após 3 tentativas')
    expect(env.events.map(e => e.evento)).toContain('monitor_resolution_kept_blocked')
    expect(env.notifier.notify).toHaveBeenCalledOnce()
  })

  it('corrida benigna: bloqueio já resolvido por outro fluxo não emite TASK_UNBLOCKED duplicado', async () => {
    const env = fakeEnvironment({ unblockAffectedRows: 0 })

    await env.consumer.handle(blockedMessage())

    expect(env.outbox('TASK_UNBLOCKED')).toHaveLength(0)
    expect(env.connection.commit).toHaveBeenCalled()
    const unblockedRecord = env.events.find(e => e.evento === 'monitor_resolution_unblocked')
    expect(unblockedRecord!.payload).toMatchObject({ unblocked: false })
  })

  it('falha ao postar chat não derruba o fluxo de desbloqueio', async () => {
    const env = fakeEnvironment()
    ;(env.pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT INTO tarefa_chats')) throw new Error('chat indisponível')
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.includes('FROM bloqueios b')) return [[BLOCKER_ROW], []]
      if (normalized.includes('projetos_captados')) return [[CONTEXT_ROW], []]
      if (normalized.includes('project_model_selection')) return [[{ model: 'gpt-5.6-sol' }], []]
      if (normalized.includes('FROM subtarefas')) return [[{ workspace_branch: 'b1' }], []]
      return [{ affectedRows: 1 }, []]
    })

    await env.consumer.handle(blockedMessage())

    expect(env.queries.some(q => q.sql.includes('UPDATE bloqueios SET resolved_at'))).toBe(true)
    expect(env.outbox('TASK_UNBLOCKED')).toHaveLength(1)
  })
})
