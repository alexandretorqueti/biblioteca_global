// @vitest-environment node
// Tarefa motor-visibilidade-setup-not-verified — sub-motivos do gate
// 'setup_not_verified', alerta deduplicado e re-disparo idempotente da missão
// de setup (brief 2026-11-19: incidentes das tarefas 1063–1070/1083 em requeue
// infinito sem causa visível, sem alerta e sem re-disparo).
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import {
  SETUP_GATE_RECOVERY_DEFAULTS,
  buildSetupGateAlertText,
  deriveSetupGateHold,
  handleSetupGateRecovery,
  setupGateAlertMarker,
  setupRedispatchMarker,
  type SetupGateHoldFacts,
} from '../../src/setup/SetupGateRecovery.js'

function facts(overrides: Partial<SetupGateHoldFacts> = {}): SetupGateHoldFacts {
  return {
    projectId: 12,
    slug: 'gestao-de-tarefas-global',
    setupStatus: 'failed',
    setupError: 'Setup reprovado na reconciliação de conclusão',
    activeGenerations: 0,
    lastGenerationStatus: 'completed',
    lastGenerationError: null,
    redispatchCount: 0,
    redispatchLastAt: null,
    ...overrides,
  }
}

/** Fake de pool que registra chamadas e responde por trecho de SQL. */
function fakePool(routes: {
  setupTask?: Array<Record<string, unknown>>
  redispatchAffected?: number
  alertAffected?: number
  waitSince?: Date | string | null
  chatAffected?: number
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const text = String(sql)
      if (text.includes('SELECT id FROM tarefas WHERE external_id')) return [routes.setupTask ?? [{ id: 99 }], []]
      if (text.includes('setup_redispatch_count = setup_redispatch_count + 1')) return [{ affectedRows: routes.redispatchAffected ?? 1 }, []]
      if (text.includes('SET setup_alert_last_at = NOW()')) return [{ affectedRows: routes.alertAffected ?? 1 }, []]
      if (text.includes('SELECT capacity_wait_since')) return [[{ capacity_wait_since: routes.waitSince ?? null }], []]
      if (text.includes('INSERT INTO motor_outbox')) return [{ affectedRows: 1, insertId: 1 }, []]
      if (text.includes('INSERT INTO tarefa_chats')) return [{ affectedRows: routes.chatAffected ?? 1, insertId: 7 }, []]
      return [[], []]
    }),
  }
  return { pool, calls }
}

const baseInput = {
  databaseTaskId: 1063,
  taskExternalId: 'task-p2-1063',
}

describe('deriveSetupGateHold — sub-motivos canônicos', () => {
  it("setup_status='failed' → setup_failed com erro real resumido", () => {
    const hold = deriveSetupGateHold(facts())
    expect(hold.state).toBe('setup_failed')
    expect(hold.error).toBe('Setup reprovado na reconciliação de conclusão')
    expect(hold.detail).toContain('FALHOU')
  })

  it("última geração falha → setup_failed com LEFT(erro,300) da geração", () => {
    const hold = deriveSetupGateHold(facts({
      setupStatus: 'pending', setupError: null,
      lastGenerationStatus: 'failed', lastGenerationError: 'preflight: docs/CONTEXTO-ANALISTA.md ausente',
    }))
    expect(hold.state).toBe('setup_failed')
    expect(hold.error).toBe('preflight: docs/CONTEXTO-ANALISTA.md ausente')
  })

  it('geração ativa (pending/running/awaiting_*) → setup_em_andamento', () => {
    const hold = deriveSetupGateHold(facts({ setupStatus: null, setupError: null, activeGenerations: 1, lastGenerationStatus: 'running' }))
    expect(hold.state).toBe('setup_em_andamento')
    expect(hold.error).toBeNull()
  })

  it("setup_status queued/running/pending sem falha → setup_em_andamento", () => {
    for (const setupStatus of ['queued', 'running', 'pending']) {
      const hold = deriveSetupGateHold(facts({ setupStatus, setupError: null, lastGenerationStatus: null }))
      expect(hold.state, `setup_status=${setupStatus}`).toBe('setup_em_andamento')
    }
  })

  it('sem setup e sem geração → setup_faltando com estado do re-disparo no detalhe', () => {
    const hold = deriveSetupGateHold(facts({ setupStatus: null, setupError: null, lastGenerationStatus: null, redispatchCount: 1 }))
    expect(hold.state).toBe('setup_faltando')
    expect(hold.detail).toContain('tentativa 2 de 3')
  })
})

describe('handleSetupGateRecovery — re-disparo idempotente (B.4)', () => {
  it('setup failed sem missão ativa → UPDATE condicional + TASK_ENQUEUED durável no outbox', async () => {
    const { pool, calls } = fakePool()
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
    })

    expect(result.redispatched).toBe(true)
    const update = calls.find(call => call.sql.includes('setup_redispatch_count = setup_redispatch_count + 1'))
    expect(update).toBeDefined()
    expect(update!.params[0]).toBe(12)
    const outbox = calls.find(call => call.sql.includes('INSERT INTO motor_outbox'))
    expect(outbox).toBeDefined()
    expect(outbox!.params[1]).toBe('TASK_ENQUEUED')
    expect(outbox!.params[3]).toBe('setup-gestao-de-tarefas-global')
    const payload = JSON.parse(String(outbox!.params[5]))
    expect(payload.reason).toBe('setup_gate_auto_redispatch')
    expect(payload.subReason).toBe('setup_failed')
    expect(payload.attempt).toBe(1)
    // Aviso legível no chat da tarefa retida, deduplicado por marcador.
    const chat = calls.find(call => call.sql.includes('INSERT INTO tarefa_chats'))
    expect(chat).toBeDefined()
    expect(String(chat!.params[1])).toContain(setupRedispatchMarker(12, 1))
  })

  it('setup em andamento → nunca re-dispara nem alerta (transição normal)', async () => {
    const { pool, calls } = fakePool()
    const holdFacts = facts({ setupStatus: 'running', setupError: null })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: holdFacts, hold: deriveSetupGateHold(holdFacts),
    })

    expect(result).toEqual({ alerted: false, redispatched: false, redispatchSkippedReason: 'sub_reason_in_progress' })
    expect(calls).toHaveLength(0)
  })

  it('setup ativo (queued) com sub-motivo problemático → sem re-disparo (rede de segurança)', async () => {
    const { pool, calls } = fakePool()
    const holdFacts = facts({ setupStatus: 'queued', lastGenerationStatus: 'failed', lastGenerationError: 'x' })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: holdFacts, hold: deriveSetupGateHold(holdFacts),
    })

    expect(result.redispatched).toBe(false)
    expect(result.redispatchSkippedReason).toBe('setup_active')
    expect(calls.some(call => call.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
  })

  it('teto de tentativas atingido → permanece em espera sem re-disparo (alerta humano)', async () => {
    const { pool, calls } = fakePool()
    const holdFacts = facts({ redispatchCount: SETUP_GATE_RECOVERY_DEFAULTS.redispatchMaxAttempts })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: holdFacts, hold: deriveSetupGateHold(holdFacts),
      config: { alertAfterMinutes: 999 },
    })

    expect(result.redispatched).toBe(false)
    expect(result.redispatchSkippedReason).toBe('attempts_exhausted')
    expect(calls.some(call => call.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
  })

  it('backoff não decorrido → sem re-disparo', async () => {
    const { pool, calls } = fakePool()
    const now = new Date('2026-11-20T18:00:00Z')
    const holdFacts = facts({ redispatchLastAt: new Date('2026-11-20T17:45:00Z') })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: holdFacts, hold: deriveSetupGateHold(holdFacts),
      config: { now: () => now, alertAfterMinutes: 999 },
    })

    expect(result.redispatched).toBe(false)
    expect(result.redispatchSkippedReason).toBe('backoff')
    expect(calls.some(call => call.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
  })

  it('missão de setup inexistente → não recria (setup_task_missing), só alerta humano', async () => {
    const { pool, calls } = fakePool({ setupTask: [], waitSince: new Date('2026-11-20T17:00:00Z') })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
      config: { now: () => new Date('2026-11-20T18:00:00Z') },
    })

    expect(result.redispatched).toBe(false)
    expect(result.redispatchSkippedReason).toBe('setup_task_missing')
    expect(calls.some(call => call.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
    expect(result.alerted).toBe(true)
  })

  it('corrida perdida no UPDATE condicional (affectedRows=0) → sem outbox duplicado', async () => {
    const { pool, calls } = fakePool({ redispatchAffected: 0 })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
      config: { alertAfterMinutes: 999 },
    })

    expect(result.redispatched).toBe(false)
    expect(calls.some(call => call.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
  })
})

describe('handleSetupGateRecovery — alerta único por janela (A.3)', () => {
  const waitedSince = new Date('2026-11-20T17:00:00Z')
  const now = () => new Date('2026-11-20T18:00:00Z')

  it('espera persistente (>30min) em setup_failed → alerta no chat com marcador por projeto+janela', async () => {
    const { pool, calls } = fakePool({ waitSince: waitedSince })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
      config: { now, alertAfterMinutes: 30, alertWindowMinutes: 60 },
    })

    expect(result.alerted).toBe(true)
    const alertUpdate = calls.find(call => call.sql.includes('SET setup_alert_last_at = NOW()'))
    expect(alertUpdate).toBeDefined()
    expect(alertUpdate!.params).toEqual([12, 60])
    const chat = calls.filter(call => call.sql.includes('INSERT INTO tarefa_chats'))
      .find(call => String(call.params[1]).includes('setup-gate-alert'))
    expect(chat).toBeDefined()
    const marker = setupGateAlertMarker(12, 'setup_failed', Math.floor(now().getTime() / (60 * 60_000)))
    expect(String(chat!.params[1])).toContain(marker)
    expect(String(chat!.params[1])).toContain('Setup do projeto FALHOU')
    expect(String(chat!.params[1])).toContain('Setup reprovado na reconciliação de conclusão')
  })

  it('janela de dedupe: alerta recente no projeto → não repete (sem spam)', async () => {
    const { pool, calls } = fakePool({ waitSince: waitedSince, alertAffected: 0 })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
      config: { now },
    })

    expect(result.alerted).toBe(false)
    expect(calls.some(call => call.sql.includes('INSERT INTO tarefa_chats') && String(call.params[1]).includes('setup-gate-alert'))).toBe(false)
  })

  it('espera curta (<30min) → sem alerta', async () => {
    const { pool, calls } = fakePool({ waitSince: new Date('2026-11-20T17:50:00Z') })
    const result = await handleSetupGateRecovery(pool as unknown as Pool, {
      ...baseInput, facts: facts(), hold: deriveSetupGateHold(facts()),
      config: { now },
    })

    expect(result.alerted).toBe(false)
    expect(calls.some(call => call.sql.includes('SET setup_alert_last_at = NOW()'))).toBe(false)
  })
})

describe('buildSetupGateAlertText — conteúdo legível', () => {
  it('setup_failed → pede correção da causa e embute o marcador de dedupe', () => {
    const marker = setupGateAlertMarker(12, 'setup_failed', 498_000)
    const text = buildSetupGateAlertText({
      taskExternalId: 'task-p2-1063', slug: 'gestao-de-tarefas-global', projectId: 12,
      state: 'setup_failed', error: 'artefato ausente', waitSince: waitedSinceIso(),
      redispatched: false, redispatchCount: 3, maxAttempts: 3, marker,
    })
    expect(text).toContain('Setup do projeto FALHOU')
    expect(text).toContain('artefato ausente')
    expect(text).toContain('Projetos → Iniciar desenvolvimento')
    expect(text).toContain(marker)
  })

  it('setup_faltando com teto atingido → mensagem pede intervenção humana', () => {
    const marker = setupGateAlertMarker(12, 'setup_faltando', 498_000)
    const text = buildSetupGateAlertText({
      taskExternalId: 'task-p2-1063', slug: 'gestao-de-tarefas-global', projectId: 12,
      state: 'setup_faltando', error: null, waitSince: waitedSinceIso(),
      redispatched: false, redispatchCount: 3, maxAttempts: 3, marker,
    })
    expect(text).toContain('teto de re-disparos atingido (3/3)')
    expect(text).toContain('intervenção humana necessária')
    expect(text).toContain(marker)
  })

  function waitedSinceIso(): string {
    return new Date('2026-11-20T17:00:00Z').toISOString()
  }
})
