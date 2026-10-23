// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OrphanCapacityQueueReconciler } from '../src/execution/OrphanCapacityQueueReconciler.js'

type QueryMock = ReturnType<typeof vi.fn>

function buildPool(queryMock: QueryMock) {
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: queryMock,
  }
  return {
    pool: { query: queryMock, getConnection: vi.fn().mockResolvedValue(connection) } as any,
    connection,
  }
}

function buildEvents() {
  return { record: vi.fn().mockResolvedValue(undefined) } as any
}

function cooldownRow(overrides: Record<string, unknown> = {}) {
  return {
    tarefa_id: 100,
    projeto_id: 1,
    task_external_id: 'task-p1-100',
    project_slug: 'gerenteagentes',
    wait_since: new Date().toISOString(),
    requested_at: new Date().toISOString(),
    retry_at: null,
    alert_at: null,
    status: 'waiting',
    ...overrides,
  }
}

function outboxInserts(queryMock: QueryMock) {
  return queryMock.mock.calls.filter(
    (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_outbox'),
  )
}

function subtaskUpdates(queryMock: QueryMock) {
  return queryMock.mock.calls.filter(
    (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE subtarefas'),
  )
}

describe('OrphanCapacityQueueReconciler — espera por cooldown de modelo DEV', () => {
  it('retoma a tarefa com gatilho único quando um modelo volta a ficar elegível', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])                       // 1. sessões órfãs
      .mockResolvedValueOnce([[]])                       // 2. fila obsoleta
      .mockResolvedValueOnce([[cooldownRow()]])          // 3. esperas de cooldown
      .mockResolvedValueOnce([[{ available: 1 }]])       // 4. modelo elegível?
      .mockResolvedValueOnce([[{ id: 100, external_id: 'task-p1-100', paused_at: null, terminal_status: null }]]) // 5. lock da tarefa
      .mockResolvedValueOnce([[{ total: 0 }]])           // 6. dedupe outbox
      .mockResolvedValueOnce([{ affectedRows: 1 }])      // 7. INSERT outbox
      .mockResolvedValueOnce([{ affectedRows: 1 }])      // 8. wake_count
    const events = buildEvents()
    const { pool, connection } = buildPool(queryMock)
    const reconciler = new OrphanCapacityQueueReconciler(pool, { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.cooldownWaitsResumed).toBe(1)
    const inserts = outboxInserts(queryMock)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]![1]).toContain('TASK_READY_FOR_PROGRAMMING')
    // A retomada NÃO transiciona subtarefa para running: o claim atômico da
    // reserva continua sendo a única transição (sem execução concorrente).
    expect(subtaskUpdates(queryMock)).toHaveLength(0)
    expect(connection.commit).toHaveBeenCalled()
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-100', 'dev_model_cooldown_resumed', 'motor',
      expect.objectContaining({ reasonCode: 'model_cooldown' }),
    )
  })

  it('deduplica a retomada quando já existe comando pendente no outbox', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])                       // 1. sessões órfãs
      .mockResolvedValueOnce([[]])                       // 2. fila obsoleta
      .mockResolvedValueOnce([[cooldownRow()]])          // 3. esperas de cooldown
      .mockResolvedValueOnce([[{ available: 1 }]])       // 4. modelo elegível?
      .mockResolvedValueOnce([[{ id: 100, external_id: 'task-p1-100', paused_at: null, terminal_status: null }]]) // 5. lock
      .mockResolvedValueOnce([[{ total: 1 }]])           // 6. dedupe: comando pendente
    const events = buildEvents()
    const { pool, connection } = buildPool(queryMock)
    const reconciler = new OrphanCapacityQueueReconciler(pool, { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.cooldownWaitsResumed).toBe(0)
    expect(outboxInserts(queryMock)).toHaveLength(0)
    expect(connection.rollback).toHaveBeenCalled()
    expect(connection.commit).not.toHaveBeenCalled()
    expect(events.record).not.toHaveBeenCalled()
  })

  it('emite um único alerta durável quando a indisponibilidade excede o limite', async () => {
    const prolonged = cooldownRow({
      wait_since: new Date(Date.now() - 60 * 60_000).toISOString(),
      retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])                       // 1. sessões órfãs
      .mockResolvedValueOnce([[]])                       // 2. fila obsoleta
      .mockResolvedValueOnce([[prolonged]])              // 3. esperas de cooldown
      .mockResolvedValueOnce([[{ available: 0 }]])       // 4. ainda em cooldown
      .mockResolvedValueOnce([[{ next_available_at: new Date(prolonged.retry_at!) }]]) // 5. MIN(until)
      .mockResolvedValueOnce([{ affectedRows: 1 }])      // 6. UPDATE retry_at
      .mockResolvedValueOnce([{ affectedRows: 1 }])      // 7. UPDATE alert_at (condicional IS NULL)
    const events = buildEvents()
    const { pool } = buildPool(queryMock)
    const reconciler = new OrphanCapacityQueueReconciler(pool, {
      taskEvents: events,
      cooldownAlertMs: 30 * 60_000,
    })

    const summary = await reconciler.reconcile()

    expect(summary.cooldownAlertsEmitted).toBe(1)
    expect(summary.cooldownWaitsResumed).toBe(0)
    // Alerta é gravado de forma durável e condicional (idempotente)
    const alertUpdate = queryMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string'
        && call[0].includes('capacity_wait_alert_at = NOW()')
        && call[0].includes('capacity_wait_alert_at IS NULL'),
    )
    expect(alertUpdate).toBeDefined()
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-100', 'dev_model_capacity_alert', 'motor',
      expect.objectContaining({ reasonCode: 'model_cooldown', limitMs: 30 * 60_000 }),
    )
    // Espera temporária nunca vira falha: nenhum UPDATE terminal é emitido
    const terminalWrites = queryMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string'
        && call[0].includes('terminal_status')
        && call[0].trimStart().toUpperCase().startsWith('UPDATE'),
    )
    expect(terminalWrites).toHaveLength(0)
  })

  it('não repete o alerta quando o controle durável já está marcado', async () => {
    const alerted = cooldownRow({
      wait_since: new Date(Date.now() - 60 * 60_000).toISOString(),
      alert_at: new Date().toISOString(),
    })
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])                       // 1. sessões órfãs
      .mockResolvedValueOnce([[]])                       // 2. fila obsoleta
      .mockResolvedValueOnce([[alerted]])                // 3. esperas de cooldown
      .mockResolvedValueOnce([[{ available: 0 }]])       // 4. ainda em cooldown
      .mockResolvedValueOnce([[{ next_available_at: null }]]) // 5. MIN(until)
      .mockResolvedValueOnce([{ affectedRows: 0 }])      // 6. UPDATE retry_at
    const events = buildEvents()
    const { pool } = buildPool(queryMock)
    const reconciler = new OrphanCapacityQueueReconciler(pool, {
      taskEvents: events,
      cooldownAlertMs: 30 * 60_000,
    })

    const summary = await reconciler.reconcile()

    expect(summary.cooldownAlertsEmitted).toBe(0)
    expect(events.record).not.toHaveBeenCalledWith(
      'task-p1-100', 'dev_model_capacity_alert', 'motor', expect.anything(),
    )
  })

  it('não alerta antes do limite configurado', async () => {
    const recent = cooldownRow({ wait_since: new Date().toISOString() })
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])                       // 1. sessões órfãs
      .mockResolvedValueOnce([[]])                       // 2. fila obsoleta
      .mockResolvedValueOnce([[recent]])                 // 3. esperas de cooldown
      .mockResolvedValueOnce([[{ available: 0 }]])       // 4. ainda em cooldown
      .mockResolvedValueOnce([[{ next_available_at: null }]]) // 5. MIN(until)
      .mockResolvedValueOnce([{ affectedRows: 0 }])      // 6. UPDATE retry_at
    const events = buildEvents()
    const { pool } = buildPool(queryMock)
    const reconciler = new OrphanCapacityQueueReconciler(pool, {
      taskEvents: events,
      cooldownAlertMs: 30 * 60_000,
    })

    const summary = await reconciler.reconcile()

    expect(summary.cooldownAlertsEmitted).toBe(0)
    const alertUpdate = queryMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('capacity_wait_alert_at = NOW()'),
    )
    expect(alertUpdate).toBeUndefined()
  })
})
