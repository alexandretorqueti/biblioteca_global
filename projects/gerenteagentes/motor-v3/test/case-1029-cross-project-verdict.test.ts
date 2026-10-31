// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { parseAnalystReply } from '../src/analysis/AnalystReply.js'
import { MySqlTaskCoordinatorRepository } from '../src/coordinator/index.js'
import { verificationChatMarker } from '../src/coordinator/VerificationRouting.js'
import { DerivedTaskStatusResolver } from '../src/status/DerivedTaskStatus.js'

/**
 * Subtarefa 4 da task-p2-1047 — reprodução ponta a ponta do caso real
 * task-p6-1029 (29/10/2026): o analista concluiu a análise com veredito
 * `verification` recomendando criar a tarefa em OUTRO projeto ("o problema
 * não é do Admin; é da Biblioteca Global — packages/ui") e o usuário NUNCA
 * foi avisado — o veredito ficou enterrado em JSON bruto nas
 * analyst_task_session_messages e o quadro agrupou a tarefa em "canceladas".
 *
 * Diferente dos testes unitários (analyst-reply-routing, verification-routing,
 * derived-task-status), este teste encadeia as três camadas sobre um banco
 * mockado STATEFUL: a resposta bruta do analista é parseada (contrato v13),
 * persistida via `persistAnalysis` e o estado gravado é relido pelo
 * `DerivedTaskStatusResolver` — provando o fluxo completo:
 *
 * 1. mensagem legível no `tarefa_chats` da origem (não JSON bruto);
 * 2. notificação ao usuário emitida (realtime `task.chat.message.created` +
 *    `task.status.changed` e `TASK_CREATED` no motor_outbox → pending_action
 *    do operational-feed);
 * 3. tarefa proposta (PAUSADA) no projeto de destino com vínculo de origem
 *    (`tarefa_eventos` nas duas tarefas) e diagnóstico copiado na descrição;
 * 4. `DerivedTaskStatusResolver` retorna `closed` (completed + 0 subtarefas)
 *    — e nunca `cancelled` — a partir dos fatos gravados pela transação.
 */

/** Resposta bruta do analista no caso 1029 (contrato v13, com routing). */
const rawAnalystReply = JSON.stringify({
  kind: 'verification',
  verdict: 'Confirmado',
  summary: 'O problema não é do Admin; é da Biblioteca Global — packages/ui.',
  evidence: ['Leitura de packages/ui/src/Card.tsx', 'Reprodução no projeto admin'],
  routing: {
    target_project_slug: 'biblioteca-global',
    recommended_title: 'Corrigir renderização do cartão em packages/ui',
    diagnosis: 'O defeito está no componente da Biblioteca Global (packages/ui), não no Admin.',
  },
})

const ORIGIN_DB_ID = 1029
const ORIGIN_EXTERNAL_ID = 'task-p6-1029'
const ORIGIN_PROJECT_ID = 6
const TARGET_PROJECT_ID = 7
const TARGET_PROJECT_SLUG = 'biblioteca-global'
const ROUTED_DB_ID = 2029

interface State {
  /** Fatos terminais gravados por persistAnalysis (task_runtime_facts). */
  facts: { terminalStatus: string | null; integrationConfirmedAt: Date | null }
  /** Subtarefas criadas (o ramo verification NUNCA cria). */
  subtasks: Array<Record<string, unknown>>
  /** Mensagens do chat da origem (tarefa_chats). */
  chatMessages: Array<{ id: number; texto: string }>
  /** Tarefas criadas por external_id (INSERT ... WHERE NOT EXISTS). */
  tasksByExternalId: Map<string, { id: number; projetoId: number; titulo: string; descricao: string; paused: boolean }>
  /** Vínculos registrados em tarefa_eventos. */
  taskEvents: Array<{ tarefaId: number; evento: string; payload: string }>
  /** Mensagens do motor_outbox (notificação pending_action). */
  outbox: Array<{ messageId: string; type: string; payload: Record<string, unknown> }>
  /** Eventos do realtime_event_outbox. */
  realtime: Array<{ type: string; previousStatus: string | null; status: string | null; payload: string }>
  /** Transações abertas/commitadas. */
  commits: number
  rollbacks: number
}

function createState(): State {
  return {
    facts: { terminalStatus: null, integrationConfirmedAt: null },
    subtasks: [],
    chatMessages: [],
    tasksByExternalId: new Map(),
    taskEvents: [],
    outbox: [],
    realtime: [],
    commits: 0,
    rollbacks: 0,
  }
}

/**
 * Conexão MySQL mockada STATEFUL: responde por padrão de SQL e grava o
 * estado como o banco real faria, permitindo que o resolver releia os fatos
 * produzidos pela transação do persistAnalysis.
 */
function createStatefulConnection(state: State) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => { state.commits += 1 }),
    rollback: vi.fn(async () => { state.rollbacks += 1 }),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })

      // Claim da análise (persistAnalysis): origem com lease ativo.
      if (sql.includes('INNER JOIN task_runtime_facts') && sql.includes('FOR UPDATE')) {
        return [[{ id: ORIGIN_DB_ID, tipo: 'desenvolvimento', external_id: ORIGIN_EXTERNAL_ID, projeto_id: ORIGIN_PROJECT_ID }], []]
      }
      if (sql.includes('UPDATE analysis_clarification_checkpoints')) return [{ affectedRows: 0 }, []]

      // Resolução do slug de destino (applyVerificationRouting).
      if (sql.includes('FROM projetos_captados WHERE slug')) {
        return [[{ id: TARGET_PROJECT_ID, slug: TARGET_PROJECT_SLUG }], []]
      }
      if (sql.includes('FROM projetos_captados WHERE id')) {
        return [[{ slug: 'admin-global' }], []]
      }

      // INSERT idempotente da tarefa roteada (WHERE NOT EXISTS por external_id).
      if (sql.includes('INSERT INTO tarefas')) {
        const [externalId, projetoId, titulo, descricao] = params as [string, number, string, string]
        if (state.tasksByExternalId.has(externalId)) return [{ affectedRows: 0 }, []]
        state.tasksByExternalId.set(externalId, {
          id: ROUTED_DB_ID, projetoId: Number(projetoId), titulo: String(titulo),
          descricao: String(descricao), paused: sql.includes('paused_at') && sql.includes('NOW()'),
        })
        return [{ affectedRows: 1, insertId: ROUTED_DB_ID }, []]
      }
      if (sql.includes('SELECT id FROM tarefas WHERE external_id')) {
        const existing = state.tasksByExternalId.get(String(params[0]))
        return [existing ? [{ id: existing.id }] : [], []]
      }

      // Vínculo de origem nas duas tarefas (evento/ator/origem são literais
      // no SQL; params = [tarefa_id, tarefa_external_id, payload]).
      if (sql.includes('INSERT INTO tarefa_eventos')) {
        const [tarefaId, , payload] = params as [number, string, string]
        const evento = sql.includes('verification_routing_origin') ? 'verification_routing_origin' : 'verification_routing'
        state.taskEvents.push({ tarefaId: Number(tarefaId), evento, payload: String(payload) })
        return [{ affectedRows: 1 }, []]
      }

      // Notificação pending_action no operational-feed
      // (params: message_id, type, destination_queue, task_id, execution_id, payload_json, ...).
      if (sql.includes('INSERT INTO motor_outbox')) {
        const [messageId, type, , , , payloadRaw] = params as [string, string, string, string, string, string]
        state.outbox.push({ messageId: String(messageId), type: String(type), payload: JSON.parse(String(payloadRaw)) })
        return [{ affectedRows: 1 }, []]
      }

      // Chat deduplicado por marcador (INSERT ... SELECT ... WHERE NOT EXISTS).
      if (sql.includes('INSERT INTO tarefa_chats')) {
        const [, texto, , markerLike] = params as [number, string, unknown, string]
        const marker = String(markerLike).replace(/^%|%$/g, '')
        if (state.chatMessages.some(message => message.texto.includes(marker))) return [{ affectedRows: 0 }, []]
        const id = 500 + state.chatMessages.length
        state.chatMessages.push({ id, texto: String(texto) })
        return [{ affectedRows: 1, insertId: id }, []]
      }

      // Fato terminal completed gravado pela análise verification.
      if (sql.includes('INSERT INTO task_runtime_facts')) {
        state.facts.terminalStatus = 'completed'
        state.facts.integrationConfirmedAt = new Date()
        return [{ affectedRows: 1 }, []]
      }

      // Realtime: identidade da tarefa, sequência e publicação do evento.
      if (sql.includes('FROM tarefas WHERE id = ?')) {
        return [[{ id: ORIGIN_DB_ID, external_id: ORIGIN_EXTERNAL_ID, projeto_id: ORIGIN_PROJECT_ID }], []]
      }
      if (sql.includes('realtime_event_outbox') && sql.includes('MAX(per_task_seq)')) {
        return [[{ next_seq: state.realtime.length + 1 }], []]
      }
      if (sql.includes('INSERT INTO realtime_event_outbox')) {
        const [eventId, taskId, sourceTaskId, projectId, subtaskId, type, previousStatus, status, payload] =
          params as [string, number, number, number, number | null, string, string | null, string | null, string]
        void eventId; void taskId; void sourceTaskId; void projectId; void subtaskId
        state.realtime.push({ type: String(type), previousStatus, status, payload: String(payload) })
        return [{ affectedRows: 1 }, []]
      }

      // Resolver: projeção de fatos da tarefa (relê o estado gravado acima).
      if (sql.includes('LEFT JOIN task_runtime_facts')) {
        return [[{
          id: ORIGIN_DB_ID, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
          analysis_started_at: new Date(), clarification_pending_at: null,
          integration_confirmed_at: state.facts.integrationConfirmedAt,
          terminal_status: state.facts.terminalStatus,
          awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
          administrative_deploy_cancelled: 0, active_monitor_fix: 0,
        }], []]
      }
      // Resolver: subtarefas da tarefa (o ramo verification nunca cria).
      if (sql.includes('FROM subtarefas WHERE tarefa_id = ?')) {
        return [state.subtasks, []]
      }

      return [[], []]
    }),
  }
  return { connection, calls, byPattern: (pattern: string) => calls.filter(call => call.sql.includes(pattern)) }
}

function createRepository(connection: unknown) {
  return new MySqlTaskCoordinatorRepository({ getConnection: vi.fn(async () => connection) } as never)
}

describe('Caso 1029 ponta a ponta — veredito cross-project do analista', () => {
  it('parse (contrato v13) → persistAnalysis → chat + notificação + tarefa no destino + status closed', async () => {
    // ——— Camada 1: a resposta bruta do analista é parseada com o routing ———
    const outcome = parseAnalystReply(rawAnalystReply, undefined, 'desenvolvimento')
    expect(outcome.kind).toBe('verification')
    if (outcome.kind !== 'verification') throw new Error('esperado veredito verification')
    expect(outcome.routing).toEqual({
      targetProjectSlug: TARGET_PROJECT_SLUG,
      recommendedTitle: 'Corrigir renderização do cartão em packages/ui',
      diagnosis: 'O defeito está no componente da Biblioteca Global (packages/ui), não no Admin.',
    })

    // ——— Camada 2: persistAnalysis grava tudo em transação única ———
    const state = createState()
    const mock = createStatefulConnection(state)
    const repository = createRepository(mock.connection)
    await repository.persistAnalysis(ORIGIN_EXTERNAL_ID, 'exec-1029', outcome)

    expect(state.commits).toBe(1)
    expect(state.rollbacks).toBe(0)

    // (1) Mensagem LEGÍVEL no tarefa_chats da origem — não JSON bruto enterrado.
    expect(state.chatMessages).toHaveLength(1)
    const chat = state.chatMessages[0]
    expect(chat.texto.trimStart().startsWith('{')).toBe(false)
    expect(chat.texto).toContain('Análise concluída — veredito de verificação')
    expect(chat.texto).toContain('Veredito:** Confirmado')
    expect(chat.texto).toContain('Biblioteca Global — packages/ui')
    expect(chat.texto).toContain('- Leitura de packages/ui/src/Card.tsx')
    expect(chat.texto).toContain('Recomendação cross-project')
    expect(chat.texto).toContain(verificationChatMarker(ORIGIN_EXTERNAL_ID))

    // (2) Notificação ao usuário emitida: realtime do chat + mudança de status
    //     e TASK_CREATED no motor_outbox (pending_action do operational-feed).
    expect(state.realtime.some(event => event.type === 'task.chat.message.created')).toBe(true)
    const statusChanged = state.realtime.find(event => event.type === 'task.status.changed')
    expect(statusChanged?.status).toBe('closed')
    expect(state.outbox).toHaveLength(1)
    expect(state.outbox[0].type).toBe('TASK_CREATED')
    expect(state.outbox[0].payload).toMatchObject({
      taskId: `task-p${TARGET_PROJECT_ID}-via-${ORIGIN_EXTERNAL_ID}`,
      paused: true,
      origin: 'analyst_verification_cross_project',
      originTaskId: ORIGIN_EXTERNAL_ID,
    })

    // (3) Tarefa PROPOSTA (pausada) no projeto de destino, com vínculo de
    //     origem nas duas tarefas e diagnóstico copiado na descrição.
    const routedExternalId = `task-p${TARGET_PROJECT_ID}-via-${ORIGIN_EXTERNAL_ID}`
    const routed = state.tasksByExternalId.get(routedExternalId)
    expect(routed).toBeDefined()
    expect(routed?.projetoId).toBe(TARGET_PROJECT_ID)
    expect(routed?.paused).toBe(true)
    expect(routed?.titulo).toBe('Corrigir renderização do cartão em packages/ui')
    expect(routed?.descricao).toContain('packages/ui), não no Admin')
    expect(routed?.descricao).toContain(ORIGIN_EXTERNAL_ID)
    expect(routed?.descricao).toContain('PAUSADA')
    expect(state.taskEvents).toHaveLength(2)
    expect(state.taskEvents[0]).toMatchObject({ tarefaId: ORIGIN_DB_ID, evento: 'verification_routing' })
    expect(state.taskEvents[0].payload).toContain(routedExternalId)
    expect(state.taskEvents[1]).toMatchObject({ tarefaId: ROUTED_DB_ID, evento: 'verification_routing_origin' })
    expect(state.taskEvents[1].payload).toContain(ORIGIN_EXTERNAL_ID)

    // (4) DerivedTaskStatusResolver relê os fatos gravados pela transação
    //     (completed + 0 subtarefas) e deriva `closed` — nunca `cancelled`.
    expect(state.facts.terminalStatus).toBe('completed')
    expect(state.subtasks).toHaveLength(0)
    const resolver = new DerivedTaskStatusResolver({ query: mock.connection.query } as never)
    await expect(resolver.resolve(ORIGIN_EXTERNAL_ID)).resolves.toBe('closed')

    // ——— Redelivery da mesma análise: nada duplica (idempotência) ———
    await repository.persistAnalysis(ORIGIN_EXTERNAL_ID, 'exec-1029', outcome)
    expect(state.chatMessages).toHaveLength(1)
    expect(state.tasksByExternalId.size).toBe(1)
    expect(state.taskEvents).toHaveLength(2)
    expect(state.outbox).toHaveLength(1)
    expect(state.commits).toBe(2)
    expect(state.rollbacks).toBe(0)
  })
})
