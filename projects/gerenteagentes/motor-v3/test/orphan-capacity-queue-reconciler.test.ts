import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OrphanCapacityQueueReconciler } from '../src/execution/OrphanCapacityQueueReconciler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryMock = ReturnType<typeof vi.fn>

function buildPool(queryMock: QueryMock) {
  return { query: queryMock } as any
}

function buildEvents() {
  return { record: vi.fn().mockResolvedValue(undefined) } as any
}

// ---------------------------------------------------------------------------
// Sessões órfãs por subtarefa terminal
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — sessões órfãs', () => {
  it('fecha sessão ativa cuja subtarefa está verified', async () => {
    const orphanRow = {
      session_id: 101,
      subtarefa_id: 501,
      session_key: 'dev-gpt-terra-task-p1-100-s501',
      runtime_session_id: 'runtime-101',
      subtask_status: 'verified',
      tarefa_id: 100,
      task_external_id: 'task-p1-100',
    }
    const queryMock = vi.fn()
      // 1ª query: SELECT orfan sessions
      .mockResolvedValueOnce([[orphanRow]])
      // 2ª query: UPDATE motor_agent_sessions
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // 3ª query: UPDATE tarefa_contextos_execucao
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // 4ª query: SELECT stale queue
      .mockResolvedValueOnce([[]])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(1)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed', close_reason = ?"),
      ['orphan_subtask_verified', 101],
    )
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('tarefa_contextos_execucao'),
      [501, 'dev-gpt-terra-task-p1-100-s501'],
    )
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-100', 'orphan_session_closed', 'motor',
      expect.objectContaining({ sessionId: 101, subtaskId: 501, subtaskStatus: 'verified' }),
    )
  })

  it('fecha sessão ativa cuja subtarefa está cancelled', async () => {
    const orphanRow = {
      session_id: 102,
      subtarefa_id: 502,
      session_key: 'dev-session-502',
      runtime_session_id: 'runtime-102',
      subtask_status: 'cancelled',
      tarefa_id: 200,
      task_external_id: null,
    }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[orphanRow]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      '200', 'orphan_session_closed', 'motor',
      expect.objectContaining({ subtaskStatus: 'cancelled', reason: 'orphan_subtask_cancelled' }),
    )
  })

  it('é idempotente: segundo ciclo não refecha sessão já fechada', async () => {
    const orphanRow = {
      session_id: 101,
      subtarefa_id: 501,
      session_key: 'dev-session-501',
      runtime_session_id: 'runtime-101',
      subtask_status: 'failed',
      tarefa_id: 100,
      task_external_id: 'task-p1-100',
    }
    const queryMock = vi.fn()
    // Primeiro ciclo: sessão encontrada e fechada
    queryMock.mockReset()
      .mockResolvedValueOnce([[orphanRow]])   // SELECT orphan sessions
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE session
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE contextos
      .mockResolvedValueOnce([[]])  // SELECT stale queue

    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))
    const first = await reconciler.reconcile()
    expect(first.orphanSessionsClosed).toBe(1)

    // Segundo ciclo: sessão não é mais encontrada (já fechada)
    queryMock.mockReset()
      .mockResolvedValueOnce([[]])  // SELECT orphan sessions — vazio
      .mockResolvedValueOnce([[]])  // SELECT stale queue
    const second = await reconciler.reconcile()
    expect(second.orphanSessionsClosed).toBe(0)
  })

  it('não fecha sessão quando UPDATE não afeta linhas (concorrência)', async () => {
    const orphanRow = {
      session_id: 101,
      subtarefa_id: 501,
      session_key: 'dev-session-501',
      runtime_session_id: 'runtime-101',
      subtask_status: 'failed',
      tarefa_id: 100,
      task_external_id: 'task-p1-100',
    }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[orphanRow]])
      // UPDATE retorna affectedRows: 0 — outro reconciliador já fechou
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(0)
    expect(events.record).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Fila de capacidade obsoleta
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — fila de capacidade', () => {
  const baseQueueRow = {
    id: 1,
    tarefa_id: 300,
    task_external_id: 'task-p1-300',
    source_message_id: 'msg-abc-123',
    status: 'waiting',
    terminal_status: null,
    paused_at: null,
    has_active_block: 0,
    has_pending_subtask: 1,
    has_running_subtask: 0,
    has_pending_outbox: 0,
  }

  it('remove entrada de fila quando tarefa está completed', async () => {
    const row = { ...baseQueueRow, terminal_status: 'completed' }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])  // orphan sessions
      .mockResolvedValueOnce([[row]])  // stale queue SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // DELETE
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM motor_execution_wait_queue'),
      [300],
    )
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-300', 'stale_capacity_wait_removed', 'motor',
      expect.objectContaining({
        dominatedReason: 'terminal_task',
        sourceMessageId: 'msg-abc-123',
        queueStatus: 'waiting',
      }),
    )
    // Garante que 'reason' não está mais no payload (coluna removida)
    const lastPayload = events.record.mock.calls[0][3] as Record<string, unknown>
    expect(lastPayload).not.toHaveProperty('reason')
  })

  it('remove entrada de fila quando tarefa está paused', async () => {
    const row = { ...baseQueueRow, paused_at: '2026-10-10 12:00:00' }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-300', 'stale_capacity_wait_removed', 'motor',
      expect.objectContaining({ dominatedReason: 'paused_task' }),
    )
  })

  it('remove entrada de fila quando tarefa tem bloqueio ativo', async () => {
    const row = { ...baseQueueRow, has_active_block: 1 }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-300', 'stale_capacity_wait_removed', 'motor',
      expect.objectContaining({ dominatedReason: 'blocked_task' }),
    )
  })

  it('remove entrada quando não há subtarefa pendente nem running', async () => {
    const row = { ...baseQueueRow, has_pending_subtask: 0, has_running_subtask: 0 }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-300', 'stale_capacity_wait_removed', 'motor',
      expect.objectContaining({ dominatedReason: 'no_eligible_subtask' }),
    )
  })

  it('remove entrada quando já existe comando pendente no outbox', async () => {
    const row = { ...baseQueueRow, has_pending_outbox: 1 }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(summary.duplicateCommandsSuppressed).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-300', 'stale_capacity_wait_removed', 'motor',
      expect.objectContaining({ dominatedReason: 'duplicate_command' }),
    )
  })

  it('preserva entrada válida (tarefa ativa, subtarefa pendente, sem comando)', async () => {
    const row = { ...baseQueueRow }  // Tudo "saudável"
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])  // orphan sessions
      .mockResolvedValueOnce([[row]])  // stale queue SELECT
    // Nenhum DELETE deve ser chamado
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(0)
    expect(events.record).not.toHaveBeenCalled()
  })

  it('preserva entrada quando subtarefa está running (limite de capacidade legítimo)', async () => {
    const row = { ...baseQueueRow, has_pending_subtask: 0, has_running_subtask: 1 }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(0)
  })

  it('é idempotente: segundo ciclo não remove entrada já removida', async () => {
    const row = { ...baseQueueRow, terminal_status: 'completed' }
    const queryMock = vi.fn()

    // Primeiro ciclo: entrada encontrada e removida
    queryMock.mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[row]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))
    const first = await reconciler.reconcile()
    expect(first.staleQueueEntriesRemoved).toBe(1)

    // Segundo ciclo: entrada já não existe
    queryMock.mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    const second = await reconciler.reconcile()
    expect(second.staleQueueEntriesRemoved).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Ciclo combinado e resistência a falhas
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — ciclo combinado', () => {
  it('executa limpeza de sessões e fila no mesmo ciclo', async () => {
    const orphanRow = {
      session_id: 201,
      subtarefa_id: 601,
      session_key: 'dev-session-601',
      runtime_session_id: 'runtime-201',
      subtask_status: 'superseded',
      tarefa_id: 400,
      task_external_id: 'task-p1-400',
    }
    const queueRow = {
      id: 5,
      tarefa_id: 500,
      task_external_id: 'task-p1-500',
      source_message_id: 'msg-def-456',
      status: 'waiting',
      terminal_status: 'failed',
      paused_at: null,
      has_active_block: 0,
      has_pending_subtask: 0,
      has_running_subtask: 0,
      has_pending_outbox: 0,
    }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[orphanRow]])      // orphan sessions SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE session
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE contextos
      .mockResolvedValueOnce([[queueRow]])        // stale queue SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // DELETE queue
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(1)
    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(events.record).toHaveBeenCalledTimes(2)
  })

  it('falha em uma sessão não impede limpeza de outras', async () => {
    const orphan1 = {
      session_id: 301, subtarefa_id: 701, session_key: 's-701',
      runtime_session_id: 'r-301', subtask_status: 'failed',
      tarefa_id: 600, task_external_id: 'task-p1-600',
    }
    const orphan2 = {
      session_id: 302, subtarefa_id: 702, session_key: 's-702',
      runtime_session_id: 'r-302', subtask_status: 'verified',
      tarefa_id: 601, task_external_id: 'task-p1-601',
    }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[orphan1, orphan2]])
      // Primeiro UPDATE falha
      .mockRejectedValueOnce(new Error('connection lost'))
      // Segundo UPDATE funciona
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]])
    const events = buildEvents()
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { taskEvents: events })

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(1)
    expect(events.record).toHaveBeenCalledWith(
      'task-p1-601', 'orphan_session_closed', 'motor',
      expect.objectContaining({ sessionId: 302 }),
    )
  })

  it('tolera falha na query principal sem quebrar o ciclo', async () => {
    const queryMock = vi.fn()
      .mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValueOnce([[]])
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))

    const summary = await reconciler.reconcile()

    expect(summary.orphanSessionsClosed).toBe(0)
    expect(summary.staleQueueEntriesRemoved).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Repetição de ciclos (critério de aceite: idempotência)
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — repetição de ciclos', () => {
  it('três ciclos consecutivos produzem resultado estável', async () => {
    const orphanRow = {
      session_id: 401, subtarefa_id: 801, session_key: 's-801',
      runtime_session_id: 'r-401', subtask_status: 'failed',
      tarefa_id: 700, task_external_id: 'task-p1-700',
    }
    const queueRow = {
      id: 10, tarefa_id: 800, task_external_id: 'task-p1-800',
      source_message_id: 'msg-ghi-789', status: 'waiting',
      terminal_status: 'completed',
      paused_at: null, has_active_block: 0,
      has_pending_subtask: 0, has_running_subtask: 0, has_pending_outbox: 0,
    }

    const queryMock = vi.fn()
    // Ciclo 1: encontra órfão e fila stale
    queryMock
      .mockResolvedValueOnce([[orphanRow]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[queueRow]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))
    const first = await reconciler.reconcile()
    expect(first.orphanSessionsClosed).toBe(1)
    expect(first.staleQueueEntriesRemoved).toBe(1)

    // Ciclo 2: nada mais encontra
    queryMock.mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    const second = await reconciler.reconcile()
    expect(second.orphanSessionsClosed).toBe(0)
    expect(second.staleQueueEntriesRemoved).toBe(0)

    // Ciclo 3: estável
    queryMock.mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
    const third = await reconciler.reconcile()
    expect(third.orphanSessionsClosed).toBe(0)
    expect(third.staleQueueEntriesRemoved).toBe(0)
  })

  it('não produz mensagens duplicadas de TASK_READY_FOR_PROGRAMMING', async () => {
    // Cenário: tarefa com subtarefa elegível, fila stale, mas já tem
    // comando pendente no outbox. O reconciliador remove a entrada da
    // fila mas NÃO insere outbox (evita duplicar).
    const queueRow = {
      id: 11, tarefa_id: 900, task_external_id: 'task-p1-900',
      source_message_id: 'msg-jkl-012', status: 'waiting',
      terminal_status: null,
      paused_at: null, has_active_block: 0,
      has_pending_subtask: 1, has_running_subtask: 0,
      has_pending_outbox: 1,
    }
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])       // orphan sessions
      .mockResolvedValueOnce([[queueRow]])  // stale queue SELECT
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // DELETE
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))

    const summary = await reconciler.reconcile()

    expect(summary.staleQueueEntriesRemoved).toBe(1)
    expect(summary.duplicateCommandsSuppressed).toBe(1)
    // Nenhuma inserção no outbox — a limpeza apenas removeu a fila stale.
    const insertCalls = queryMock.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_outbox'),
    )
    expect(insertCalls).toHaveLength(0)
  })

  it('não referencia a coluna inexistente q.reason de motor_execution_wait_queue', async () => {
    // Regressão do incidente de 2026-10-11: o SELECT da fila de capacidade
    // referenciava `q.reason`, coluna que nunca existiu no schema. O erro era
    // engolido pelo catch do ciclo e o reconciliador de órfãos/fila morria em
    // produção a cada minuto sem limpá-los. O mock não valida SQL contra o
    // schema real, então o contrato é verificado sobre o texto da query.
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[]])  // orphan sessions
      .mockResolvedValueOnce([[]])  // stale queue SELECT
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock))

    await reconciler.reconcile()

    const selectCall = queryMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('FROM motor_execution_wait_queue'),
    )
    expect(selectCall).toBeDefined()
    expect(selectCall![0]).not.toMatch(/q\.reason/)
  })
})

// ---------------------------------------------------------------------------
// start/stop
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — lifecycle', () => {
  it('start cria timer e stop limpa', () => {
    const queryMock = vi.fn().mockResolvedValue([[]])
    const reconciler = new OrphanCapacityQueueReconciler(buildPool(queryMock), { intervalMs: 60_000 })
    reconciler.start()
    // Não crasha
    reconciler.stop()
    reconciler.stop() // Duplo stop não crasha
  })
})

// ---------------------------------------------------------------------------
// Regressão: colunas do SELECT vs. schema real (migration 0056)
// ---------------------------------------------------------------------------

describe('OrphanCapacityQueueReconciler — regressão schema', () => {
  it('todas as colunas q.* no SELECT de cleanStaleCapacityQueue existem em motor_execution_wait_queue (migration 0056)', () => {
    const srcPath = resolve(
      __dirname,
      '../src/execution/OrphanCapacityQueueReconciler.ts',
    )
    const migrationPath = resolve(
      __dirname,
      '../../migrations/0056_motor_execution_wait_queue.sql',
    )
    const source = readFileSync(srcPath, 'utf-8')
    const migration = readFileSync(migrationPath, 'utf-8')

    // Extrai todas as colunas q.* referenciadas no SELECT de
    // cleanStaleCapacityQueue (qualquer q.identificador fora de
    // subqueries — o FROM principal usa alias q).
    const qColumnRefs = [...source.matchAll(/\bq\.(\w+)/g)].map(m => m[1])
    const uniqueQCols = [...new Set(qColumnRefs)]

    // Colunas definidas na migration 0056 (CREATE TABLE motor_execution_wait_queue).
    const columnBlock = migration.match(
      /CREATE TABLE[^;]+/s,
    )?.[0] ?? ''
    const definedColumns = [
      ...columnBlock.matchAll(
        /^\s*`(\w+)`\s+\w+/gm,
      ),
    ].map(m => m[1])

    expect(definedColumns.length).toBeGreaterThan(0)

    for (const col of uniqueQCols) {
      expect(
        definedColumns,
        `Coluna q.${col} referenciada no SELECT não existe em motor_execution_wait_queue (migration 0056)`,
      ).toContain(col)
    }
  })
})
