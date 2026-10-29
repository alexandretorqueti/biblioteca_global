// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  ConsoleHumanNotifier,
  TaskChatHumanNotifier,
  buildMonitorAlertText,
  monitorNotifyMarker,
} from '../src/monitor/HumanNotifier.js'

// ---------------------------------------------------------------------------
// Tarefa 1043 / Subtarefa 3 — HumanNotifier real: alerta deduplicado do
// Monitor não resolvido no chat da tarefa (tarefa_chats, role 'assistant'),
// com deduplicação por marcador estável (blockId quando disponível; senão
// digest taskId+blockReason+resumo) via INSERT ... WHERE NOT EXISTS.
// Canal escolhido pelo usuário: chat da tarefa na plataforma — NUNCA Telegram.
// ---------------------------------------------------------------------------

interface QueryEntry { sql: string; params: unknown[] }

function makePool(opts: { taskIdFound?: boolean; chatInsertAffectedRows?: number } = {}) {
  const { taskIdFound = true, chatInsertAffectedRows = 1 } = opts
  const queries: QueryEntry[] = []
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.includes('FROM tarefas')) return [taskIdFound ? [{ id: 886 }] : []]
    if (normalized.includes('INSERT INTO tarefa_chats')) {
      return [{ affectedRows: chatInsertAffectedRows, insertId: 555 }, []]
    }
    return [[]]
  })
  return { pool: { query } as never, queries }
}

function chatInserts(queries: QueryEntry[]): QueryEntry[] {
  return queries.filter(q => q.sql.includes('INSERT INTO tarefa_chats'))
}

describe('monitorNotifyMarker — marcador estável de deduplicação', () => {
  it('usa o blockId quando disponível (estável entre tentativas/redelivery)', () => {
    const a = monitorNotifyMarker({ taskId: 'task-p2-1043', blockReason: 'worker_exhausted', summary: 'resumo A', blockId: 45 })
    const b = monitorNotifyMarker({ taskId: 'task-p2-1043', blockReason: 'worker_exhausted', summary: 'resumo B diferente', blockId: 45 })
    expect(a).toBe('[motor-v3:monitor-notify:block:45]')
    expect(b).toBe(a)
  })

  it('aceita blockId como string numérica e ignora valores inválidos', () => {
    expect(monitorNotifyMarker({ taskId: 't', blockReason: 'r', summary: 's', blockId: '45' }))
      .toBe('[motor-v3:monitor-notify:block:45]')
    const semBlockId = monitorNotifyMarker({ taskId: 't', blockReason: 'r', summary: 's', blockId: null })
    expect(semBlockId).toMatch(/^\[motor-v3:monitor-notify:[0-9a-f]{32}\]$/)
    expect(monitorNotifyMarker({ taskId: 't', blockReason: 'r', summary: 's', blockId: 'abc' })).toBe(semBlockId)
  })

  it('sem blockId: digest determinístico de taskId+blockReason+resumo', () => {
    const input = { taskId: 'task-p2-1043', blockReason: 'postdeploy_inconclusivo', summary: 'inconclusivo após 1 tentativas' }
    const first = monitorNotifyMarker(input)
    const second = monitorNotifyMarker({ ...input })
    expect(first).toBe(second)
    const different = monitorNotifyMarker({ ...input, summary: 'outro resumo' })
    expect(different).not.toBe(first)
  })
})

describe('buildMonitorAlertText — causa, evidência e ação recomendada', () => {
  it('inclui causa, evidência, ação recomendada e o marcador no texto', () => {
    const text = buildMonitorAlertText({
      taskId: 'task-p2-1043', blockReason: 'worker_exhausted',
      summary: 'status=NAO_RESOLVIDO origem=MOTOR. Causa raiz não identificada.', blockId: 45,
    })
    expect(text).toContain('**Tarefa:** task-p2-1043')
    expect(text).toContain('**Causa:** worker_exhausted')
    expect(text).toContain('**Evidência:** status=NAO_RESOLVIDO')
    expect(text).toContain('**Ação recomendada:**')
    expect(text).toContain('[motor-v3:monitor-notify:block:45]')
  })

  it('não menciona Telegram (canal do alerta é o chat da tarefa)', () => {
    const text = buildMonitorAlertText({ taskId: 't', blockReason: 'r', summary: 's' })
    expect(text.toLowerCase()).not.toContain('telegram')
  })
})

describe('TaskChatHumanNotifier — alerta deduplicado no chat da tarefa', () => {
  it('grava mensagem assistant em tarefa_chats com INSERT ... WHERE NOT EXISTS pelo marcador', async () => {
    const { pool, queries } = makePool()
    const notifier = new TaskChatHumanNotifier(pool)

    await notifier.notify({
      taskId: 'task-p2-1043', blockReason: 'worker_exhausted',
      summary: 'O worker esgotou as tentativas.', blockId: 45,
    })

    const inserts = chatInserts(queries)
    expect(inserts).toHaveLength(1)
    const insert = inserts[0]
    expect(insert.sql).toContain('WHERE NOT EXISTS')
    expect(insert.sql).toContain("role")
    // Parâmetros: [databaseTaskId, texto, databaseTaskId, %marcador%]
    expect(insert.params[0]).toBe(886)
    expect(insert.params[2]).toBe(886)
    expect(insert.params[3]).toBe('%[motor-v3:monitor-notify:block:45]%')
    expect(String(insert.params[1])).toContain('🚨')
    expect(String(insert.params[1])).toContain('worker_exhausted')
    expect(String(insert.params[1])).toContain('O worker esgotou as tentativas.')
  })

  it('resolve taskId numérico pelos dois critérios (external_id ou id)', async () => {
    const { pool, queries } = makePool()
    const notifier = new TaskChatHumanNotifier(pool)

    await notifier.notify({ taskId: '886', blockReason: 'r', summary: 's', blockId: 7 })

    const lookup = queries.find(q => q.sql.includes('FROM tarefas'))!
    expect(lookup.sql).toContain('external_id = ? OR CAST(id AS CHAR) = ?')
    expect(lookup.params).toEqual(['886', '886'])
  })

  it('alertas repetidos para o mesmo bloqueio usam o mesmo marcador (deduplicação no banco)', async () => {
    const { pool, queries } = makePool()
    const notifier = new TaskChatHumanNotifier(pool)

    await notifier.notify({ taskId: 'task-p2-1043', blockReason: 'worker_exhausted', summary: 'tentativa 1', blockId: 45 })
    await notifier.notify({ taskId: 'task-p2-1043', blockReason: 'worker_exhausted', summary: 'tentativa 2', blockId: 45 })

    const inserts = chatInserts(queries)
    expect(inserts).toHaveLength(2)
    // Mesmo marcador de deduplicação nas duas tentativas → o WHERE NOT EXISTS
    // do banco impede a segunda mensagem (redelivery seguro).
    expect(inserts[0].params[3]).toBe(inserts[1].params[3])
    expect(inserts[0].params[3]).toBe('%[motor-v3:monitor-notify:block:45]%')
  })

  it('mensagem já existente (affectedRows 0) não gera erro — deduplicada', async () => {
    const { pool, queries } = makePool({ chatInsertAffectedRows: 0 })
    const notifier = new TaskChatHumanNotifier(pool)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(notifier.notify({ taskId: 'task-p2-1043', blockReason: 'r', summary: 's', blockId: 45 })).resolves.toBeUndefined()
    expect(chatInserts(queries)).toHaveLength(1)
    expect(warn.mock.calls.some(call => String(call[0]).includes('deduplicado'))).toBe(true)
    warn.mockRestore()
  })

  it('sem blockId: deduplica por digest de taskId+blockReason+resumo', async () => {
    const { pool, queries } = makePool()
    const notifier = new TaskChatHumanNotifier(pool)
    const input = { taskId: 'task-p2-1043', blockReason: 'postdeploy_inconclusivo', summary: 'inconclusivo após 1 tentativas. Batch b-1.' }

    await notifier.notify(input)
    await notifier.notify({ ...input })

    const inserts = chatInserts(queries)
    expect(inserts).toHaveLength(2)
    expect(inserts[0].params[3]).toBe(inserts[1].params[3])
    expect(String(inserts[0].params[3])).toMatch(/^%\[motor-v3:monitor-notify:[0-9a-f]{32}\]%$/)
  })

  it('tarefa não encontrada: não grava chat e não lança (melhor-esforço com log)', async () => {
    const { pool, queries } = makePool({ taskIdFound: false })
    const notifier = new TaskChatHumanNotifier(pool)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(notifier.notify({ taskId: 'task-inexistente', blockReason: 'r', summary: 's' })).resolves.toBeUndefined()
    expect(chatInserts(queries)).toHaveLength(0)
    expect(warn.mock.calls.some(call => String(call[0]).includes('não encontrada'))).toBe(true)
    warn.mockRestore()
  })

  it('falha de banco não propaga (notificação nunca derruba o fluxo do Monitor)', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('banco fora do ar')) } as never
    const notifier = new TaskChatHumanNotifier(pool)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(notifier.notify({ taskId: 'task-p2-1043', blockReason: 'r', summary: 's', blockId: 45 })).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('ConsoleHumanNotifier — fallback log-only (interface plugável)', () => {
  it('mantém eco diagnóstico em log sem gravar chat nem Telegram', async () => {
    const notifier = new ConsoleHumanNotifier()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(notifier.notify({ taskId: 'task-p2-1043', blockReason: 'r', summary: 's', blockId: 45 })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
