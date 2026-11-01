// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlTaskCoordinatorRepository } from '../src/coordinator/index.js'
import {
  applyVerificationRouting,
  buildRoutedTaskDescription,
  buildRoutedTaskTitle,
  buildVerificationChatText,
  routedTaskExternalId,
  verificationChatMarker,
  type VerificationRoutingResult,
} from '../src/coordinator/VerificationRouting.js'
import type { AnalysisOutcome } from '../src/analysis/AnalystReply.js'

/**
 * Subtarefa 2 da task-p2-1047 (caso real task-p6-1029): veredito cross-project
 * do analista publica chat legível, notifica o usuário e cria tarefa proposta
 * no projeto de destino — tudo na mesma transação do persistAnalysis, com
 * idempotência (redelivery não duplica mensagem nem tarefa) e degradação
 * segura quando o slug de destino não existe.
 */

const originTaskRow = { id: 42, tipo: 'verificacao', external_id: 'task-p6-1029', projeto_id: 6 }
const targetProject = { id: 7, slug: 'biblioteca-global' }
const realtimeIdentity = { id: 42, external_id: 'task-p6-1029', projeto_id: 6 }

const verificationOutcome: AnalysisOutcome = {
  kind: 'verification',
  verdict: 'Confirmado',
  summary: 'O problema não é do Admin; é da Biblioteca Global — packages/ui.',
  evidence: ['Leitura de packages/ui/src/Card.tsx', 'Reprodução no projeto admin'],
  routing: {
    targetProjectSlug: 'biblioteca-global',
    recommendedTitle: 'Corrigir renderização do cartão em packages/ui',
    diagnosis: 'O defeito está no componente da Biblioteca Global (packages/ui), não no Admin.',
  },
}

interface MockOptions {
  /** affectedRows do INSERT da tarefa roteada (0 simula redelivery). */
  routedTaskAffectedRows?: number
  /** affectedRows do INSERT deduplicado do chat (0 simula redelivery). */
  chatAffectedRows?: number
  /** Projeto de destino retornado pela resolução do slug (vazio = inválido). */
  targetProjectRows?: Array<Record<string, unknown>>
  /** Quando true, não responde queries do realtime (identity vazia). */
  skipRealtime?: boolean
}

/** Mock de conexão que responde por padrão de SQL (ordem-independente). */
function createConnection(options: MockOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      if (sql.includes('FROM tarefas t') && sql.includes('task_runtime_facts')) return [[originTaskRow], []]
      if (sql.includes('UPDATE analysis_clarification_checkpoints')) return [{ affectedRows: 0 }, []]
      if (sql.includes('FROM projetos_captados WHERE slug')) return [options.targetProjectRows ?? [targetProject], []]
      if (sql.includes('FROM projetos_captados WHERE id')) return [[{ slug: 'admin-global' }], []]
      if (sql.includes('INSERT INTO tarefas')) return [{ affectedRows: options.routedTaskAffectedRows ?? 1, insertId: 99 }, []]
      if (sql.includes('SELECT id FROM tarefas WHERE external_id')) return [[{ id: 99 }], []]
      if (sql.includes('INSERT INTO tarefa_eventos')) return [{ affectedRows: 1, insertId: calls.length }, []]
      if (sql.includes('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }, []]
      if (sql.includes('INSERT INTO tarefa_chats')) return [{ affectedRows: options.chatAffectedRows ?? 1, insertId: 500 }, []]
      if (sql.includes('INSERT INTO task_runtime_facts')) return [{ affectedRows: 1 }, []]
      if (sql.includes('FROM tarefas WHERE id = ?')) {
        if (options.skipRealtime) return [[], []]
        return [[realtimeIdentity], []]
      }
      if (sql.includes('realtime_event_outbox') && sql.includes('MAX(per_task_seq)')) return [[{ next_seq: 1 }], []]
      if (sql.includes('INSERT INTO realtime_event_outbox')) return [{ affectedRows: 1 }, []]
      return [[], []]
    }),
  }
  return { connection, calls, byPattern: (pattern: string) => calls.filter(call => call.sql.includes(pattern)) }
}

function createRepository(connection: unknown) {
  return new MySqlTaskCoordinatorRepository({ getConnection: vi.fn(async () => connection) } as any)
}

describe('VerificationRouting — funções puras', () => {
  it('marcador de idempotência ancora no external id da tarefa', () => {
    expect(verificationChatMarker('task-p6-1029')).toBe('[motor-v3:verification:task-p6-1029]')
  })

  it('external_id determinístico mantém prefixo canônico e cabe em varchar(64)', () => {
    expect(routedTaskExternalId(7, 'task-p6-1029')).toBe('task-p7-via-task-p6-1029')
    const longOrigin = `task-p6-${'9'.repeat(80)}`
    const id = routedTaskExternalId(640, longOrigin)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(routedTaskExternalId(640, longOrigin)).toBe(id)
  })

  it('título usa recommended_title, com fallback para resumo e limite de 200', () => {
    const base = { verdict: 'Confirmado', summary: 'Resumo longo', routing: verificationOutcome.routing! }
    expect(buildRoutedTaskTitle({ ...base })).toBe('Corrigir renderização do cartão em packages/ui')
    expect(buildRoutedTaskTitle({ ...base, routing: { targetProjectSlug: 'x' } })).toBe('Resumo longo')
    expect(buildRoutedTaskTitle({ ...base, routing: { targetProjectSlug: 'x' }, summary: 'S'.repeat(300) }).length).toBeLessThanOrEqual(200)
  })

  it('descrição da tarefa roteada copia diagnóstico, evidências e origem', () => {
    const description = buildRoutedTaskDescription({
      originDatabaseTaskId: 42, originExternalId: 'task-p6-1029', originProjectId: 6,
      originProjectSlug: 'admin-global',
      routing: verificationOutcome.routing!, verdict: 'Confirmado',
      summary: verificationOutcome.summary, evidence: verificationOutcome.evidence,
    })
    expect(description).toContain('task-p6-1029')
    expect(description).toContain('admin-global')
    expect(description).toContain('packages/ui), não no Admin')
    expect(description).toContain('Leitura de packages/ui/src/Card.tsx')
    expect(description).toContain('PAUSADA')
  })

  it('chat legível inclui veredito, resumo, evidências, recomendação cross-project e marcador', () => {
    const routing: VerificationRoutingResult = {
      status: 'created', targetProjectId: 7, targetProjectSlug: 'biblioteca-global',
      routedTaskId: 99, routedTaskExternalId: 'task-p7-via-task-p6-1029',
      routedTaskTitle: 'Corrigir renderização do cartão em packages/ui',
    }
    const text = buildVerificationChatText({
      taskId: 'task-p6-1029', verdict: 'Confirmado',
      summary: verificationOutcome.summary, evidence: verificationOutcome.evidence,
    }, routing)
    expect(text).toContain('Veredito:** Confirmado')
    expect(text).toContain('Biblioteca Global — packages/ui')
    expect(text).toContain('- Leitura de packages/ui/src/Card.tsx')
    expect(text).toContain('Recomendação cross-project')
    expect(text).toContain('task-p7-via-task-p6-1029')
    expect(text).toContain('PAUSADA')
    expect(text).toContain(verificationChatMarker('task-p6-1029'))
    expect(text.trimStart().startsWith('{')).toBe(false)
  })

  it('destino inválido vira alerta explícito no chat', () => {
    const text = buildVerificationChatText(
      { taskId: 'task-p6-1029', verdict: 'Confirmado', summary: 'Resumo', evidence: [] },
      { status: 'invalid_target', targetProjectSlug: 'projeto-fantasma', reason: 'o projeto de destino não foi encontrado em projetos_captados (ou está inativo)' },
    )
    expect(text).toContain('Roteamento cross-project NÃO executado')
    expect(text).toContain('projeto-fantasma')
    expect(text).toContain('crie manualmente a tarefa')
  })
})

describe('applyVerificationRouting — transação', () => {
  const input = {
    originDatabaseTaskId: 42, originExternalId: 'task-p6-1029', originProjectId: 6,
    routing: verificationOutcome.routing!, verdict: 'Confirmado',
    summary: verificationOutcome.summary, evidence: verificationOutcome.evidence,
  }

  it('cria tarefa pausada com vínculo nas duas tarefas e TASK_CREATED no outbox', async () => {
    const { connection, byPattern } = createConnection()
    const result = await applyVerificationRouting(connection as any, input)
    expect(result).toMatchObject({ status: 'created', targetProjectId: 7, routedTaskId: 99, routedTaskExternalId: 'task-p7-via-task-p6-1029' })

    const insertTask = byPattern('INSERT INTO tarefas')[0]
    expect(insertTask.sql).toContain("paused_at")
    expect(insertTask.sql).toContain('NOW()')
    expect(insertTask.sql).toContain('WHERE NOT EXISTS')
    expect(insertTask.params[0]).toBe('task-p7-via-task-p6-1029')
    expect(insertTask.params[1]).toBe(7)
    expect(String(insertTask.params[3])).toContain('packages/ui), não no Admin')

    const events = byPattern('INSERT INTO tarefa_eventos')
    expect(events).toHaveLength(2)
    expect(events[0].sql).toContain('verification_routing')
    expect(events[0].params[0]).toBe(42)
    expect(String(events[0].params[2])).toContain('task-p7-via-task-p6-1029')
    expect(events[1].sql).toContain('verification_routing_origin')
    expect(events[1].params[0]).toBe(99)
    expect(String(events[1].params[2])).toContain('task-p6-1029')

    const outbox = byPattern('INSERT INTO motor_outbox')[0]
    expect(outbox.params[1]).toBe('TASK_CREATED')
    expect(outbox.params[0]).toBe('task-created-task-p7-via-task-p6-1029')
  })

  it('redelivery (INSERT sem efeito) retorna existing sem duplicar eventos nem outbox', async () => {
    const { connection, byPattern } = createConnection({ routedTaskAffectedRows: 0 })
    const result = await applyVerificationRouting(connection as any, input)
    expect(result).toMatchObject({ status: 'existing', routedTaskId: 99 })
    expect(byPattern('INSERT INTO tarefa_eventos')).toHaveLength(0)
    expect(byPattern('INSERT INTO motor_outbox')).toHaveLength(0)
  })

  it('slug inexistente/inativo degrada para invalid_target sem criar tarefa', async () => {
    const { connection, byPattern } = createConnection({ targetProjectRows: [] })
    const result = await applyVerificationRouting(connection as any, input)
    expect(result).toMatchObject({ status: 'invalid_target', targetProjectSlug: 'biblioteca-global' })
    expect(byPattern('INSERT INTO tarefas')).toHaveLength(0)
    expect(byPattern('INSERT INTO tarefa_eventos')).toHaveLength(0)
    expect(byPattern('INSERT INTO motor_outbox')).toHaveLength(0)
  })
})

describe('persistAnalysis — ramo verification (caso 1029)', () => {
  it('veredito com routing: chat legível + realtime + tarefa de destino + closed, em transação única', async () => {
    const mock = createConnection()
    const repository = createRepository(mock.connection)
    await repository.persistAnalysis('task-p6-1029', 'exec-1', verificationOutcome)

    // Mensagem de chat legível e idempotente (INSERT ... WHERE NOT EXISTS por marcador)
    const chat = mock.byPattern('INSERT INTO tarefa_chats')[0]
    expect(chat.sql).toContain('WHERE NOT EXISTS')
    expect(chat.params[3]).toBe(`%${verificationChatMarker('task-p6-1029')}%`)
    const texto = String(chat.params[1])
    expect(texto).toContain('Veredito:** Confirmado')
    expect(texto).toContain('Recomendação cross-project')
    expect(texto.trimStart().startsWith('{')).toBe(false)

    // Realtime do chat (appendChatMessage) e do status closed (append)
    const realtimeInserts = mock.byPattern('INSERT INTO realtime_event_outbox')
    expect(realtimeInserts.some(call => call.params[5] === 'task.chat.message.created')).toBe(true)
    expect(realtimeInserts.some(call => call.params[5] === 'task.status.changed' && call.params[7] === 'closed')).toBe(true)

    // Tarefa de destino criada pausada + eventos + outbox
    expect(mock.byPattern('INSERT INTO tarefas')).toHaveLength(1)
    expect(mock.byPattern('INSERT INTO tarefa_eventos')).toHaveLength(2)
    expect(mock.byPattern('INSERT INTO motor_outbox')).toHaveLength(1)

    // Fato terminal completed (→ closed) mantido e transação única
    expect(mock.byPattern('INSERT INTO task_runtime_facts')).toHaveLength(1)
    expect(mock.connection.commit).toHaveBeenCalledOnce()
    expect(mock.connection.rollback).not.toHaveBeenCalled()
  })

  it('redelivery da mesma análise não duplica mensagem de chat nem tarefa de destino', async () => {
    const mock = createConnection({ routedTaskAffectedRows: 0, chatAffectedRows: 0 })
    const repository = createRepository(mock.connection)
    await expect(repository.persistAnalysis('task-p6-1029', 'exec-1', verificationOutcome)).resolves.toBeUndefined()

    expect(mock.byPattern('INSERT INTO tarefa_eventos')).toHaveLength(0)
    expect(mock.byPattern('INSERT INTO motor_outbox')).toHaveLength(0)
    // Chat deduplicado (affectedRows 0) → nenhum evento realtime de chat reemitido
    const realtimeInserts = mock.byPattern('INSERT INTO realtime_event_outbox')
    expect(realtimeInserts.some(call => call.params[5] === 'task.chat.message.created')).toBe(false)
    expect(mock.connection.commit).toHaveBeenCalledOnce()
    expect(mock.connection.rollback).not.toHaveBeenCalled()
  })

  it('slug de destino inválido: alerta no chat, análise NÃO falha e tarefa é encerrada (closed)', async () => {
    const mock = createConnection({ targetProjectRows: [] })
    const repository = createRepository(mock.connection)
    await expect(repository.persistAnalysis('task-p6-1029', 'exec-1', verificationOutcome)).resolves.toBeUndefined()

    expect(mock.byPattern('INSERT INTO tarefas')).toHaveLength(0)
    const texto = String(mock.byPattern('INSERT INTO tarefa_chats')[0].params[1])
    expect(texto).toContain('Roteamento cross-project NÃO executado')
    expect(texto).toContain('biblioteca-global')
    expect(mock.byPattern('INSERT INTO task_runtime_facts')).toHaveLength(1)
    expect(mock.connection.commit).toHaveBeenCalledOnce()
    expect(mock.connection.rollback).not.toHaveBeenCalled()
  })

  it('veredito sem routing publica chat legível e não cria tarefa', async () => {
    const mock = createConnection()
    const repository = createRepository(mock.connection)
    const withoutRouting: AnalysisOutcome = {
      kind: 'verification',
      verdict: verificationOutcome.verdict,
      summary: verificationOutcome.summary,
      evidence: verificationOutcome.evidence,
    }
    await repository.persistAnalysis('task-p6-1029', 'exec-1', withoutRouting)

    const texto = String(mock.byPattern('INSERT INTO tarefa_chats')[0].params[1])
    expect(texto).toContain('Veredito:** Confirmado')
    expect(texto).not.toContain('Recomendação cross-project')
    expect(texto).toContain(verificationChatMarker('task-p6-1029'))
    expect(mock.byPattern('INSERT INTO tarefas')).toHaveLength(0)
    expect(mock.connection.commit).toHaveBeenCalledOnce()
  })
})
