import { describe, expect, it, vi } from 'vitest'
import {
  inspectResumeTerminalState,
  deriveResumeRejection,
  buildAlreadyTerminalResumeResponse,
  buildResumeRejectionChatText,
  resumeRejectionMarker,
  MySqlResumeRejectionNotifier,
} from '../src/coordinator/ResumeTerminalGuard.js'

function poolReturning(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue([rows, []])
  return { query }
}

/** Pool fake que responde por conteúdo de SQL e captura todas as chamadas.
 * `header` é o ResultSetHeader direto (pool.query real retorna [header, fields]
 * para INSERT/UPDATE). */
function routingPool(routes: Array<{ match: RegExp; rows?: unknown[]; header?: Record<string, unknown> }>) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const route = routes.find(r => r.match.test(String(sql)))
    if (!route) return [[], []]
    if (route.header) return [route.header, []]
    return [route.rows ?? [], []]
  })
  return { query }
}

describe('inspectResumeTerminalState', () => {
  it('retorna terminal_status canônico e contagem de subtarefas do caso 1029 (closed)', async () => {
    const pool = poolReturning([{ terminal_status: 'completed', subtask_count: 0 }])

    const state = await inspectResumeTerminalState(pool as never, 'task-p6-1029')

    expect(state).toEqual({ found: true, terminalStatus: 'completed', subtaskCount: 0 })
    expect(pool.query.mock.calls[0]?.[0]).toContain('task_runtime_facts f ON f.tarefa_id = t.id')
    expect(pool.query.mock.calls[0]?.[0]).toContain('subtarefas')
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['task-p6-1029', 'task-p6-1029'])
  })

  it('normaliza terminal_status gravado com caixa/espaços divergentes', async () => {
    const pool = poolReturning([{ terminal_status: ' Cancelled ', subtask_count: 2 }])

    await expect(inspectResumeTerminalState(pool as never, '42')).resolves.toEqual({
      found: true, terminalStatus: 'cancelled', subtaskCount: 2,
    })
  })

  it('retorna terminalStatus nulo para tarefa existente não terminal (fluxo assíncrono preservado)', async () => {
    const pool = poolReturning([{ terminal_status: null, subtask_count: 0 }])

    await expect(inspectResumeTerminalState(pool as never, 'task-p2-1047')).resolves.toEqual({
      found: true, terminalStatus: null, subtaskCount: 0,
    })
  })

  it('retorna found=false quando a tarefa não existe', async () => {
    const pool = poolReturning([])

    await expect(inspectResumeTerminalState(pool as never, 'task-inexistente')).resolves.toEqual({
      found: false, terminalStatus: null, subtaskCount: 0,
    })
  })
})

describe('deriveResumeRejection', () => {
  it('completed + 0 subtarefas deriva closed com motivo legível (nunca silencioso)', () => {
    const { derivedStatus, reason } = deriveResumeRejection('completed', 0)

    expect(derivedStatus).toBe('closed')
    expect(reason).toContain('veredito')
    expect(reason).toContain('closed')
    expect(reason).toContain('nova tarefa')
  })

  it('completed com subtarefas deriva completed (não closed)', () => {
    const { derivedStatus } = deriveResumeRejection('completed', 3)

    expect(derivedStatus).toBe('completed')
  })

  it.each(['cancelled', 'failed'])('%s deriva o próprio estado terminal', status => {
    expect(deriveResumeRejection(status, 0).derivedStatus).toBe(status)
  })
})

describe('buildAlreadyTerminalResumeResponse', () => {
  it('produz resposta idempotente explícita com accepted=false para tarefa closed', () => {
    const response = buildAlreadyTerminalResumeResponse('task-p6-1029', 'completed', 0)

    expect(response).toEqual({
      ok: true,
      accepted: false,
      alreadyTerminal: true,
      taskId: 'task-p6-1029',
      terminalStatus: 'completed',
      derivedStatus: 'closed',
      message: expect.stringContaining('Resume rejeitado'),
    })
    expect(response.message).toContain('veredito')
  })
})

describe('MySqlResumeRejectionNotifier', () => {
  it('grava evento resume_rejected_terminal e mensagem deduplicada no chat da tarefa', async () => {
    const pool = routingPool([
      { match: /INSERT INTO tarefa_eventos/, header: { affectedRows: 1 } },
      { match: /SELECT id FROM tarefas/, rows: [{ id: 12 }] },
      { match: /INSERT INTO tarefa_chats/, header: { affectedRows: 1, insertId: 77 } },
    ])
    const notifier = new MySqlResumeRejectionNotifier(pool as never)

    await notifier.notifyResumeRejected('task-p6-1029', 'completed', 0)

    const sqls = pool.query.mock.calls.map(call => String(call[0]))
    expect(sqls.some(sql => sql.includes('INSERT INTO tarefa_eventos'))).toBe(true)
    const eventCall = pool.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO tarefa_eventos'))
    expect(eventCall?.[1]?.[0]).toBe('resume_rejected_terminal')
    expect(String(eventCall?.[1]?.[2])).toContain('"derivedStatus":"closed"')
    const chatCall = pool.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO tarefa_chats'))
    expect(chatCall).toBeDefined()
    expect(String(chatCall?.[1]?.[1])).toContain(resumeRejectionMarker('task-p6-1029', 'completed'))
    expect(String(chatCall?.[1]?.[1])).toContain('Resume rejeitado')
  })

  it('não duplica o alerta do chat em redelivery (INSERT deduplicado retorna affectedRows=0)', async () => {
    const pool = routingPool([
      { match: /INSERT INTO tarefa_eventos/, header: { affectedRows: 1 } },
      { match: /SELECT id FROM tarefas/, rows: [{ id: 12 }] },
      { match: /INSERT INTO tarefa_chats/, header: { affectedRows: 0 } },
    ])
    const notifier = new MySqlResumeRejectionNotifier(pool as never)

    await expect(notifier.notifyResumeRejected('task-p6-1029', 'completed', 0)).resolves.toBeUndefined()
  })

  it('falha de auditoria não propaga (melhor-esforço, fluxo principal preservado)', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('banco indisponível')) }
    const notifier = new MySqlResumeRejectionNotifier(pool as never)

    await expect(notifier.notifyResumeRejected('task-1', 'cancelled', 0)).resolves.toBeUndefined()
  })
})

describe('buildResumeRejectionChatText', () => {
  it('inclui tarefa, estado terminal, status derivado e marcador de idempotência', () => {
    const text = buildResumeRejectionChatText('task-p6-1029', 'completed', 0)

    expect(text).toContain('task-p6-1029')
    expect(text).toContain('closed')
    expect(text).toContain(resumeRejectionMarker('task-p6-1029', 'completed'))
  })
})
