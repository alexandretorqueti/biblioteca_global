import { describe, expect, it, vi } from 'vitest'
import { DeployOrphanBatchReconcilerCycle } from '../src/deploy/DeployOrphanBatchReconcilerCycle.js'

function healthyConsumer() {
  return {
    requestReconciliation: vi.fn().mockResolvedValue(0),
    reconcileOrphanPendingBatches: vi.fn().mockResolvedValue(0),
    enqueuePendingDispatches: vi.fn().mockResolvedValue(0),
  }
}

function failingRequestReconciliation() {
  const consumer = healthyConsumer()
  consumer.requestReconciliation.mockRejectedValue(new Error('ERROR 1052: Column \'status\' in where clause is ambiguous'))
  return consumer
}

describe('DeployOrphanBatchReconcilerCycle (incidente 19/11 — fases independentes)', () => {
  it('falha em requestReconciliation NÃO impede reconcileOrphanPendingBatches nem enqueuePendingDispatches (aceite 4)', async () => {
    const consumer = failingRequestReconciliation()
    consumer.reconcileOrphanPendingBatches.mockResolvedValue(2)
    const events: Array<{ event: string; phase?: string }> = []
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, {
      logEvent: (event, payload) => events.push({ event, phase: payload.phase as string | undefined }),
    })

    const result = await cycle.runCycle()

    expect(result.ok).toBe(false)
    expect(result.failedPhases).toEqual(['request_reconciliation'])
    expect(result.cleaned).toBe(2)
    // Fases 2 e 3 rodaram apesar da fase 1 ter falhado.
    expect(consumer.reconcileOrphanPendingBatches).toHaveBeenCalledTimes(1)
    expect(consumer.enqueuePendingDispatches).toHaveBeenCalledTimes(1)
    // Eventos estruturados: por fase (novo) + do ciclo (mantido).
    expect(events).toEqual(
      expect.arrayContaining([
        { event: 'deploy_orphan_pending_batches_reconciliation_failed', phase: 'request_reconciliation' },
        { event: 'deploy_orphan_pending_batches_cycle_failed', phase: undefined },
      ]),
    )
  })

  it('enqueuePendingDispatches roda em TODO ciclo, mesmo com cleaned = 0 (incidente 2026-11-22 — deploy_request 437 órfão)', async () => {
    const consumer = healthyConsumer()
    consumer.reconcileOrphanPendingBatches.mockResolvedValue(0)
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { logEvent: () => {} })

    const result = await cycle.runCycle()

    expect(result.ok).toBe(true)
    expect(result.cleaned).toBe(0)
    expect(consumer.enqueuePendingDispatches).toHaveBeenCalledTimes(1)
  })

  it('falha em reconcileOrphanPendingBatches não impede requestReconciliation (já executada) nem lança para fora do ciclo', async () => {
    const consumer = healthyConsumer()
    consumer.reconcileOrphanPendingBatches.mockRejectedValue(new Error('boom'))
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { logEvent: () => {} })

    const result = await cycle.runCycle()

    expect(result.ok).toBe(false)
    expect(result.failedPhases).toEqual(['reconcile_orphan_pending_batches'])
    expect(consumer.requestReconciliation).toHaveBeenCalledTimes(1)
    // Fase 3 independe da fase 2: pedidos pending sem batch também precisam
    // de re-enqueue periódico (incidente 2026-11-22).
    expect(consumer.enqueuePendingDispatches).toHaveBeenCalledTimes(1)
  })

  it('falha isolada em enqueuePendingDispatches marca apenas essa fase', async () => {
    const consumer = healthyConsumer()
    consumer.reconcileOrphanPendingBatches.mockResolvedValue(1)
    consumer.enqueuePendingDispatches.mockRejectedValue(new Error('dispatch down'))
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { logEvent: () => {} })

    const result = await cycle.runCycle()

    expect(result.failedPhases).toEqual(['enqueue_pending_dispatches'])
    expect(result.cleaned).toBe(1)
  })
})

describe('DeployOrphanBatchReconcilerCycle — contagem de falhas consecutivas + alerta Telegram', () => {
  function cycleWithAlert(opts?: { alertAfterFailures?: number; now?: () => number }) {
    const alertSender = { send: vi.fn().mockResolvedValue(undefined) }
    const events: string[] = []
    const consumer = failingRequestReconciliation()
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, {
      alertAfterFailures: opts?.alertAfterFailures ?? 3,
      alertSender,
      now: opts?.now,
      logEvent: event => events.push(event),
    })
    return { cycle, alertSender, consumer, events }
  }

  it('incrementa a contagem por ciclo falho, dispara alerta após N (=3) consecutivos e reseta em ciclo verde', async () => {
    const { cycle, alertSender } = cycleWithAlert()

    await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(1)
    expect(alertSender.send).not.toHaveBeenCalled()

    await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(2)
    expect(alertSender.send).not.toHaveBeenCalled()

    await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(3)
    expect(alertSender.send).toHaveBeenCalledTimes(1)
    expect(alertSender.send.mock.calls[0][0]).toContain('3x seguidas')
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(3)
    expect(cycle.getHealth().lastFailedPhase).toBe('request_reconciliation')

    // Ciclos seguintes continuam falhando (4,5) — o cooldown padrão (60min,
    // relógio real) segura o 2º alerta; o reset em ciclo verde é testado
    // abaixo em 'ciclo verde reseta a contagem consecutiva'.
    await cycle.runCycle()
    await cycle.runCycle()
    // Continua falhando (4,5) mas o cooldown padrão (60min, relógio real) segura o 2º alerta.
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(5)
    expect(alertSender.send).toHaveBeenCalledTimes(1)
  })

  it('cooldown entre alertas: novo alerta só após a janela', async () => {
    let clock = 1_000_000
    const { cycle, alertSender } = cycleWithAlert({ now: () => clock })

    await cycle.runCycle()
    await cycle.runCycle()
    await cycle.runCycle()
    expect(alertSender.send).toHaveBeenCalledTimes(1)

    // ciclos 4-6 dentro do cooldown → sem novo alerta
    await cycle.runCycle()
    await cycle.runCycle()
    await cycle.runCycle()
    expect(alertSender.send).toHaveBeenCalledTimes(1)

    // avança além do cooldown (padrão 60min) → ciclo falho seguinte alerta de novo
    clock += 61 * 60_000
    await cycle.runCycle()
    expect(alertSender.send).toHaveBeenCalledTimes(2)
  })

  it('ciclo verde reseta a contagem consecutiva', async () => {
    let clock = 0
    const alertSender = { send: vi.fn().mockResolvedValue(undefined) }
    const consumer = {
      requestReconciliation: vi.fn().mockRejectedValue(new Error('x')),
      reconcileOrphanPendingBatches: vi.fn().mockResolvedValue(0),
      enqueuePendingDispatches: vi.fn().mockResolvedValue(0),
    }
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { alertSender, now: () => clock, logEvent: () => {} })

    await cycle.runCycle()
    await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(2)

    consumer.requestReconciliation.mockResolvedValue(0)
    await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(0)
    expect(cycle.getHealth().totalFailedCycles).toBe(2)
    expect(cycle.getHealth().lastCycleError).toBeNull()

    // Volta a falhar: precisa de 3 NOVOS ciclos falhos para alertar.
    consumer.requestReconciliation.mockRejectedValue(new Error('x'))
    clock += 1
    await cycle.runCycle()
    await cycle.runCycle()
    expect(alertSender.send).not.toHaveBeenCalled()
    clock += 1
    await cycle.runCycle()
    expect(alertSender.send).toHaveBeenCalledTimes(1)
  })

  it('falha do próprio alerta não derruba o ciclo', async () => {
    const consumer = failingRequestReconciliation()
    const alertSender = { send: vi.fn().mockRejectedValue(new Error('telegram down')) }
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { alertSender, logEvent: () => {} })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await cycle.runCycle()
    await cycle.runCycle()
    await expect(cycle.runCycle()).resolves.toMatchObject({ ok: false })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('alerta falhou'))
    spy.mockRestore()
  })

  it('sem alertSender configurado → nunca alerta, contagem segue visível no health', async () => {
    const consumer = failingRequestReconciliation()
    const cycle = new DeployOrphanBatchReconcilerCycle(consumer, { logEvent: () => {} })
    for (let i = 0; i < 5; i++) await cycle.runCycle()
    expect(cycle.getHealth().consecutiveFailedCycles).toBe(5)
    expect(cycle.getHealth().lastAlertAt).toBeNull()
  })
})
