// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository, type SubtaskExecutionContext } from '../src/execution/DevelopmentExecutionRepository.js'
import { SubtaskTerminalFailureBlocker } from '../src/execution/SubtaskTerminalFailureBlocker.js'
import { SubtaskExecutionConsumer } from '../src/execution/SubtaskExecutionConsumer.js'
import { IntegrationBranchMissingError } from '../src/execution/GitWorktreePreparer.js'
import type { TerminalFailureContext } from '../src/queue/TerminalFailureHandler.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

// ---------------------------------------------------------------------------
// Tarefa 1043 — toda falha terminal de subtarefa (antes da sessão, durante o
// DEV e após o baseline) precisa persistir bloqueio com causa/evidência/ação
// recomendada e alerta deduplicado ao operador no chat da tarefa, ou executar
// política automática de recuperação auditada (resetTaskToReady nunca silencioso).
// ---------------------------------------------------------------------------

const context: SubtaskExecutionContext = {
  taskId: 'task-p2-1043', databaseTaskId: 1043, projectId: 2, subtaskId: 1403, seq: 1,
  taskTitle: 'Fluxo terminal', taskDescription: '', title: 'Implementar mudança', scope: 'motor-v3',
  acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes', repoPath: '/repo',
  baseBranch: 'base-desenvolvimento', buildCommand: 'npm run build', testCommand: 'npm test',
  agentId: 'gerenteagentes', workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
  completionKind: 'code_change', generation: 1,
}

const source: QueueMessage = {
  messageId: 'execute-1403', type: 'SUBTASK_EXECUTION_REQUESTED', taskId: context.taskId,
  executionId: 'exec-1403', payload: { subtaskId: 1403 }, timestamp: new Date().toISOString(), attempt: 1,
}

interface QueryEntry { sql: string; params: unknown[] }

function makePool(opts: {
  blockInsertAffectedRows?: number
  chatInsertAffectedRows?: number
  hasCorrective?: boolean
} = {}) {
  const queries: QueryEntry[] = []
  const { blockInsertAffectedRows = 1, chatInsertAffectedRows = 1, hasCorrective = false } = opts
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.startsWith('UPDATE subtarefas SET status = ?')) return [{ affectedRows: 1 }]
    if (normalized.includes('correction_for_subtask_id')) return [hasCorrective ? [{ id: 1499 }] : []]
    if (normalized.startsWith('INSERT INTO bloqueios')) return [{ affectedRows: blockInsertAffectedRows }]
    if (normalized.startsWith('SELECT id FROM bloqueios')) return [[{ id: 77 }]]
    if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
    if (normalized.startsWith('INSERT INTO tarefa_chats')) return [{ affectedRows: chatInsertAffectedRows, insertId: 555 }]
    if (normalized.includes('FROM motor_execution_wait_queue')) return [[]]
    return [[]]
  })
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
  return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, queries, connection }
}

function findChatInsert(queries: QueryEntry[]): QueryEntry | undefined {
  return queries.find(q => q.sql.startsWith('INSERT INTO tarefa_chats'))
}

describe('finishExecution — falha terminal uniforme com bloqueio + alerta no chat (tarefa 1043)', () => {
  it('momento 1 (antes da sessão): falha de preparação cria bloqueio subtask_terminal_failure com evidência e alerta', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, {
      success: false, attempts: 1, error: 'Falha de preparação: spawn git ENOENT',
    })

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    expect(blockerInsert!.params).toEqual(expect.arrayContaining([1043, 1403, 'subtask_terminal_failure', 'SUBTASK_EXECUTION_FAILED']))
    const excerpt = JSON.parse(blockerInsert!.params[4] as string)
    expect(excerpt.messageType).toBe('SUBTASK_EXECUTION_REQUESTED')
    expect(excerpt.executionId).toBe('exec-1403')
    expect(excerpt.subtaskId).toBe(1403)
    expect(excerpt.attempts).toBe(1)
    expect(excerpt.error).toContain('spawn git ENOENT')
    expect(typeof excerpt.recommendedAction).toBe('string')
    expect(excerpt.recommendedAction.length).toBeGreaterThan(20)

    // Alerta ao operador na mesma transação, idempotente por marcador do blockId
    const chat = findChatInsert(fake.queries)
    expect(chat).toBeDefined()
    const texto = String(chat!.params[1])
    expect(texto).toContain('Bloqueio automático')
    expect(texto).toContain('task-p2-1043')
    expect(texto).toContain('1403')
    expect(texto).toContain('spawn git ENOENT')
    expect(texto).toContain('Próximo passo')
    expect(texto).toContain('[motor-v3:block:77]')
    expect(chat!.params[3]).toBe('%[motor-v3:block:77]%')

    // TASK_BLOCKED para o Monitor-Resolvedor
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox?.params).toEqual(expect.arrayContaining([
      'TASK_BLOCKED', context.taskId, expect.stringContaining('terminal-block'),
    ]))
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('momento 1 (antes da sessão): falta de modelos DEV cria bloqueio e alerta', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, {
      success: false, attempts: 0,
      error: 'Nenhum modelo DEV habilitado e disponível para o projeto (todos ausentes ou em cooldown)',
    })

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    expect(blockerInsert!.params).toEqual(expect.arrayContaining(['subtask_terminal_failure']))
    expect(findChatInsert(fake.queries)).toBeDefined()
    expect(String(findChatInsert(fake.queries)!.params[1])).toContain('Nenhum modelo DEV')
  })

  it('momento 2 (durante DEV): falha comum do worker sem esgotar tentativas também bloqueia e alerta', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, {
      success: false, attempts: 1, error: 'timeout do worker ao concluir a sessão',
    })

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    expect(blockerInsert!.params).toEqual(expect.arrayContaining([1043, 1403, 'subtask_terminal_failure']))
    const excerpt = JSON.parse(blockerInsert!.params[4] as string)
    expect(excerpt.attempts).toBe(1)
    expect(excerpt.error).toContain('timeout do worker')
    expect(findChatInsert(fake.queries)).toBeDefined()
  })

  it('momento 3 (após baseline): worker_exhausted mantém reason dedicado e ganha alerta no chat', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, {
      success: false, attempts: 3,
      error: 'Esgotado número máximo de tentativas (3): O programador declarou conclusão, mas não alterou o worktree autorizado',
    })

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert!.params).toEqual(expect.arrayContaining(['worker_exhausted']))
    const excerpt = JSON.parse(blockerInsert!.params[4] as string)
    expect(excerpt.attempts).toBe(3)
    expect(excerpt.subtaskId).toBe(1403)
    expect(excerpt.executionId).toBe('exec-1403')
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox?.params).toEqual(expect.arrayContaining([
      'TASK_BLOCKED', context.taskId, expect.stringContaining('worker-exhausted-block'),
    ]))
    const chat = findChatInsert(fake.queries)
    expect(chat).toBeDefined()
    expect(String(chat!.params[1])).toContain('[motor-v3:block:77]')
    expect(String(chat!.params[1])).toContain('worker_exhausted')
  })

  it('idempotência: redelivery da mesma falha não duplica bloqueio nem alerta no chat', async () => {
    const fake = makePool({ blockInsertAffectedRows: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, { success: false, attempts: 1, error: 'timeout' })

    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(true)
    expect(findChatInsert(fake.queries)).toBeUndefined()
    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'))).toBe(false)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('idempotência do alerta: mensagem existente com o marcador do blockId não é reinserida', async () => {
    const fake = makePool({ chatInsertAffectedRows: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, { success: false, attempts: 1, error: 'timeout' })

    const chat = findChatInsert(fake.queries)
    expect(chat).toBeDefined()
    // Guarda NOT EXISTS por marcador do blockId
    expect(chat!.sql).toContain('WHERE NOT EXISTS')
    expect(chat!.params[3]).toBe('%[motor-v3:block:77]%')
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('preserva a corretiva já criada: sem bloqueio nem alerta quando há subtarefa de correção ativa', async () => {
    const fake = makePool({ hasCorrective: true })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, { success: false, attempts: 2, error: 'falha qualquer' })

    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(findChatInsert(fake.queries)).toBeUndefined()
  })

  it('sucesso não cria bloqueio nem alerta', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.finishExecution(context, source, { success: true, response: '::DONE::', attempts: 1 })

    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(findChatInsert(fake.queries)).toBeUndefined()
  })
})

describe('SubtaskTerminalFailureBlocker — alerta deduplicado no chat da tarefa (tarefa 1043)', () => {
  function terminalContext(messageType = 'SUBTASK_EXECUTION_REQUESTED'): TerminalFailureContext {
    const message: QueueMessage = {
      messageId: 'msg-terminal-1043', type: messageType, taskId: 'task-p2-1043',
      executionId: 'exec-1403', payload: { subtaskId: 1403 },
      timestamp: new Date().toISOString(), attempt: 3,
    }
    return {
      message, attempt: 3, reason: 'max-attempts-exceeded',
      error: new Error('HTTP 504: Gateway Timeout no Console'),
    }
  }

  function makeBlockerPool(opts: { blockInsertAffectedRows?: number; chatInsertAffectedRows?: number } = {}) {
    const queries: QueryEntry[] = []
    const { blockInsertAffectedRows = 1, chatInsertAffectedRows = 1 } = opts
    const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params })
      if (/INSERT INTO bloqueios/i.test(sql)) return [{ affectedRows: blockInsertAffectedRows }]
      if (/UPDATE subtarefas/i.test(sql)) return [{ affectedRows: 1 }]
      if (/SELECT b\.id, b\.tarefa_id/i.test(sql)) return [[{ id: 99, tarefa_id: 640 }]]
      if (/INSERT INTO motor_outbox/i.test(sql)) return [{ affectedRows: 1 }]
      if (/INSERT INTO tarefa_chats/i.test(sql)) return [{ affectedRows: chatInsertAffectedRows, insertId: 900 }]
      return [{}]
    })
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(), query,
    }
    return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, queries, connection }
  }

  it('emite alerta ao operador na mesma transação do bloqueio, com marcador do blockId', async () => {
    const fake = makeBlockerPool()
    const blocker = new SubtaskTerminalFailureBlocker(fake.pool)

    await blocker.blockForTerminalFailure(terminalContext())

    const chat = fake.queries.find(q => /INSERT INTO tarefa_chats/i.test(q.sql))
    expect(chat).toBeDefined()
    const texto = String(chat!.params[1])
    expect(texto).toContain('task-p2-1043')
    expect(texto).toContain('1403')
    expect(texto).toContain('subtask_terminal_failure')
    expect(texto).toContain('HTTP 504')
    expect(texto).toContain('Próximo passo')
    expect(texto).toContain('[motor-v3:block:99]')
    expect(chat!.params[0]).toBe(640)
    expect(chat!.params[3]).toBe('%[motor-v3:block:99]%')
    expect(chat!.sql).toContain('WHERE NOT EXISTS')
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('inclui subtaskId na evidência estruturada do block_excerpt', async () => {
    const fake = makeBlockerPool()
    const blocker = new SubtaskTerminalFailureBlocker(fake.pool)

    await blocker.blockForTerminalFailure(terminalContext('SUBTASK_VERIFICATION_REQUESTED'))

    const insertQuery = fake.queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    const excerpt = JSON.parse(String(insertQuery!.params[2]))
    expect(excerpt.messageType).toBe('SUBTASK_VERIFICATION_REQUESTED')
    expect(excerpt.executionId).toBe('exec-1403')
    expect(excerpt.subtaskId).toBe(1403)
    expect(excerpt.attempt).toBe(3)
    expect(excerpt.error).toContain('HTTP 504')

    const chat = fake.queries.find(q => /INSERT INTO tarefa_chats/i.test(q.sql))
    expect(String(chat!.params[1])).toContain('subtask_verification_failed')
  })

  it('redelivery com bloqueio existente não duplica alerta no chat', async () => {
    const fake = makeBlockerPool({ blockInsertAffectedRows: 0 })
    const blocker = new SubtaskTerminalFailureBlocker(fake.pool)

    await blocker.blockForTerminalFailure(terminalContext())

    expect(fake.connection.commit).toHaveBeenCalled()
    expect(fake.queries.find(q => /INSERT INTO tarefa_chats/i.test(q.sql))).toBeUndefined()
    expect(fake.queries.find(q => /INSERT INTO motor_outbox/i.test(q.sql))).toBeUndefined()
  })

  it('alerta já existente (affectedRows=0 no INSERT deduplicado) não quebra a transação', async () => {
    const fake = makeBlockerPool({ chatInsertAffectedRows: 0 })
    const blocker = new SubtaskTerminalFailureBlocker(fake.pool)

    await expect(blocker.blockForTerminalFailure(terminalContext())).resolves.toBeUndefined()
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })
})

describe('resetTaskToReady — política automática de recuperação nunca silenciosa (tarefa 1043)', () => {
  function makeResetPool(opts: { chatInsertAffectedRows?: number } = {}) {
    const queries: QueryEntry[] = []
    const { chatInsertAffectedRows = 1 } = opts
    const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params })
      if (normalized.startsWith('SELECT id, external_id FROM tarefas')) return [[{ id: 1043, external_id: 'task-p2-1043' }]]
      if (normalized.startsWith('SELECT id, seq, titulo, status FROM subtarefas')) {
        return [[
          { id: 1403, seq: 1, titulo: 'Bloco terminal uniforme', status: 'failed' },
          { id: 1404, seq: 2, titulo: 'Retomada correta', status: 'blocked' },
        ]]
      }
      if (normalized.startsWith('INSERT INTO tarefa_chats')) return [{ affectedRows: chatInsertAffectedRows, insertId: 901 }]
      if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
      return [[]]
    })
    const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
    return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, queries, connection }
  }

  it('grava mensagem de auditoria com causa e subtarefas reabertas', async () => {
    const fake = makeResetPool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.resetTaskToReady('task-p2-1043', 'Branch de integração inexistente: integration-1043 para tarefa task-p2-1043')

    const chat = fake.queries.find(q => q.sql.startsWith('INSERT INTO tarefa_chats'))
    expect(chat).toBeDefined()
    const texto = String(chat!.params[1])
    expect(chat!.params[0]).toBe(1043)
    expect(texto).toContain('Reset automático')
    expect(texto).toContain('Branch de integração inexistente')
    expect(texto).toContain('#1403')
    expect(texto).toContain('#1404')
    expect(texto).toContain("estava 'failed'")
    expect(texto).toContain('[motor-v3:reset:')

    // O reprocessamento continua garantido via outbox
    const outbox = fake.queries.find(q => q.sql.startsWith('INSERT INTO motor_outbox'))
    expect(outbox).toBeDefined()
    expect(outbox!.params).toEqual(expect.arrayContaining(['TASK_READY_FOR_PROGRAMMING', 'task-p2-1043']))
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('causa padrão quando o consumidor não informa motivo', async () => {
    const fake = makeResetPool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.resetTaskToReady('task-p2-1043')

    const chat = fake.queries.find(q => q.sql.startsWith('INSERT INTO tarefa_chats'))
    expect(String(chat!.params[1])).toContain('Ambiente de trabalho perdido')
  })

  it('SubtaskExecutionConsumer repassa a causa do IntegrationBranchMissingError ao reset', async () => {
    const executionContext = {
      ...context, taskId: 'task-p6-845', databaseTaskId: 845, subtaskId: 901,
    }
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(executionContext),
      resetTaskToReady: vi.fn().mockResolvedValue(undefined),
    }
    const worktrees = {
      prepare: vi.fn().mockRejectedValue(new IntegrationBranchMissingError('task-p6-845', 'integration-845')),
    }
    const worker = { executeTask: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)
    const message: QueueMessage = {
      messageId: 'execute-901', type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-p6-845',
      executionId: 'exec-901', payload: { subtaskId: 901, seq: 1 },
      timestamp: new Date().toISOString(), attempt: 1,
    }

    await consumer.handle(message)

    expect(repository.resetTaskToReady).toHaveBeenCalledWith(
      'task-p6-845',
      'Branch de integração inexistente: integration-845 para tarefa task-p6-845',
    )
    expect(worker.executeTask).not.toHaveBeenCalled()
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      primitiveCode: 'prepare_worktree',
      result: expect.objectContaining({ action: 'reset_to_ready' }),
    }))
  })
})
