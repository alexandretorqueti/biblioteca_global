// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { ActiveExecutionSweeper } from '../src/monitor/ActiveExecutionSweeper.js'

// ---------------------------------------------------------------------------
// Helpers (padrão de mock de pool de orphan-capacity-queue-reconciler.test.ts)
// ---------------------------------------------------------------------------

type QueryMock = ReturnType<typeof vi.fn>

function buildPool(queryMock: QueryMock) {
  return { query: queryMock } as any
}

function deleteCall(queryMock: QueryMock): string {
  const call = queryMock.mock.calls.find(
    (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM motor_active_executions'),
  )
  expect(call, 'expected a DELETE against motor_active_executions').toBeDefined()
  return call![0] as string
}

// ---------------------------------------------------------------------------
// (a) Remoção de linhas expiradas das duas fases com a SQL correta
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — remoção de expiradas', () => {
  it('emite DELETE restrito às fases monitor/postdeploy_monitor com expires_at <= NOW()', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 37 }]) // DELETE
      .mockResolvedValueOnce([[{ remaining: 0 }]])   // COUNT remaining
    const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

    const summary = await sweeper.reconcile()

    expect(summary.swept).toBe(37)
    expect(summary.remainingExpired).toBe(0)

    const sql = deleteCall(queryMock)
    expect(sql).toContain("phase IN ('monitor', 'postdeploy_monitor')")
    expect(sql).toContain('expires_at <= NOW()')
    // Parâmetros: a query usa apenas literais SQL seguros (sem interpolação
    // dinâmica), então o array de params do pool.query é omitido.
    expect(queryMock.mock.calls[0]![1]).toBeUndefined()
  })

  it('telemetria: cada ciclo emite log estruturado com swept e remainingExpired', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ affectedRows: 4 }])
        .mockResolvedValueOnce([[{ remaining: 0 }]])
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      await sweeper.reconcile()

      const line = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('active_execution_sweep'))
      expect(line).toBeDefined()
      expect(JSON.parse(line!)).toMatchObject({ event: 'active_execution_sweep', swept: 4, remainingExpired: 0 })
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// (b) Lease válido nunca é alvo do DELETE
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — proteção de execuções vigentes e leases', () => {
  it('DELETE nunca casa expires_at futuro nem fases analysis/development', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ remaining: 0 }]])
    const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

    await sweeper.reconcile()

    const sql = deleteCall(queryMock)
    // Só remove o que venceu: a condição de expiração é <= NOW(), nunca >.
    expect(sql).toContain('expires_at <= NOW()')
    expect(sql).not.toContain('expires_at > NOW()')
    expect(sql).not.toMatch(/expires_at\s*(IS NULL|>=)/)
    // Fases de lease (heartbeat/reconciliadores próprios) jamais são alvo.
    expect(sql).not.toContain("'analysis'")
    expect(sql).not.toContain("'development'")
    expect(sql).not.toContain('heartbeat_at')
    // DELETE é restrito por phase + expires_at no mesmo WHERE (sem variante
    // sem filtro): o texto da query contém a restrição de fase ANTES da
    // condição de expiração e não há DELETE adicional sem phase IN.
    const phaseIdx = sql.indexOf("phase IN ('monitor', 'postdeploy_monitor')")
    const expiryIdx = sql.indexOf('expires_at <= NOW()')
    expect(phaseIdx).toBeGreaterThan(-1)
    expect(expiryIdx).toBeGreaterThan(phaseIdx)
  })

  it('DELETE sem parâmetros extras e único por ciclo', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      .mockResolvedValueOnce([[{ remaining: 0 }]])
    const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

    await sweeper.reconcile()

    const deletes = queryMock.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE'),
    )
    expect(deletes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// (c) Idempotência e ausência de linhas expiradas
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — idempotência', () => {
  it('ciclo repetido sem linhas expiradas retorna swept=0 sem erro (duas passagens = restart)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ affectedRows: 3 }]) // boot: expurga legadas
        .mockResolvedValueOnce([[{ remaining: 0 }]])
        .mockResolvedValueOnce([{ affectedRows: 0 }]) // segundo ciclo: nada expirado
        .mockResolvedValueOnce([[{ remaining: 0 }]])
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      const first = await sweeper.reconcile()
      const second = await sweeper.reconcile()

      expect(first.swept).toBe(3)
      expect(second.swept).toBe(0)
      expect(second.remainingExpired).toBe(0)
      expect(warnSpy).not.toHaveBeenCalled()
      // Ambos os ciclos emitem DELETE idêntico — operação é a mesma passada.
      expect(deleteCall(queryMock)).toContain("phase IN ('monitor', 'postdeploy_monitor')")
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('guarda anti-reentrância: segundo reconcile concorrente não sobrepõe o primeiro', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      let release: (value: [{ affectedRows: number }]) => void = () => {}
      const deleteGate = new Promise<[{ affectedRows: number }]>(resolve => { release = resolve })
      const queryMock = vi.fn()
        .mockImplementationOnce(() => deleteGate) // DELETE bloqueado
        .mockResolvedValueOnce([[{ remaining: 0 }]]) // COUNT do 1º ciclo
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      const first = sweeper.reconcile()
      const second = await sweeper.reconcile() // entra enquanto o 1º está em andamento

      expect(second).toEqual({ swept: 0, remainingExpired: 0 })

      release([{ affectedRows: 5 }])
      const firstSummary = await first
      expect(firstSummary.swept).toBe(5)
      // Apenas um DELETE executado (o ciclo concorrente foi ignorado).
      const deletes = queryMock.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('DELETE'),
      )
      expect(deletes).toHaveLength(1)
    } finally {
      logSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// (d) Falha de banco não propaga
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — tolerância a falha', () => {
  it('erro no DELETE é logado via console.warn e não derruba o ciclo', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const queryMock = vi.fn().mockRejectedValueOnce(new Error('ER_LOCK_wait_timeout'))
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      await expect(sweeper.reconcile()).resolves.toEqual({ swept: 0, remainingExpired: 0 })
      expect(warnSpy).toHaveBeenCalled()
      expect(String(warnSpy.mock.calls[0]![1])).toContain('ER_LOCK_wait_timeout')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('erro no COUNT após DELETE bem-sucedido também não propaga', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ affectedRows: 7 }])
        .mockRejectedValueOnce(new Error('mysql down'))
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      // O DELETE de fato removeu 7 linhas antes do COUNT falhar; o resumo
      // preserva o sucesso parcial e apenas remainingExpired fica 0.
      await expect(sweeper.reconcile()).resolves.toEqual({ swept: 7, remainingExpired: 0 })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('reconcile pode rodar de novo após falha (timer segue vivo)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryMock = vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ remaining: 0 }]])
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock))

      const failed = await sweeper.reconcile()
      const recovered = await sweeper.reconcile()
      expect(failed.swept).toBe(0)
      expect(recovered.swept).toBe(1)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Lifecycle start/stop
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — lifecycle', () => {
  it('start cria timer periódico, stop limpa e duplo stop é seguro', async () => {
    const queryMock = vi.fn().mockResolvedValue([{ affectedRows: 0 }])
    const sweeper = new ActiveExecutionSweeper(buildPool(queryMock), { intervalMs: 10_000 })

    sweeper.start()
    sweeper.start() // duplicado não cria segundo timer nem crasha
    sweeper.stop()
    sweeper.stop() // duplo stop não crasha
    expect(queryMock).not.toHaveBeenCalled() // timer não dispara imediato
  })

  it('timer periódico dispara reconcile no intervalo', async () => {
    vi.useFakeTimers()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryMock = vi.fn()
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([[{ remaining: 0 }]])
      const sweeper = new ActiveExecutionSweeper(buildPool(queryMock), { intervalMs: 300_000 })

      sweeper.start()
      await vi.advanceTimersByTimeAsync(300_000)

      expect(deleteCall(queryMock)).toContain('motor_active_executions')
      sweeper.stop()
    } finally {
      logSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Wiring no start.ts (boot + periodicidade + shutdown)
// ---------------------------------------------------------------------------

describe('ActiveExecutionSweeper — wiring no boot do motor', () => {
  it('start.ts instancia o sweeper, roda reconcile no boot, start() e stop() no shutdown', async () => {
    const start = await readFile(new URL('../src/start.ts', import.meta.url), 'utf8')

    expect(start).toContain('ActiveExecutionSweeper')
    // Boot: reconcile síncrono ao startup + resumo logado + timer periódico.
    expect(start).toContain('await activeExecutionSweeper.reconcile()')
    expect(start).toContain('activeExecutionSweeper.start()')
    // Intervalo configurável via env com default 5 min.
    expect(start).toContain('MOTOR_ACTIVE_EXECUTION_SWEEP_INTERVAL_MS')
    // Shutdown garante parada.
    expect(start).toContain('activeExecutionSweeper?.stop()')
  })

  it('motor-v3 default de intervalMs é 5 minutos', async () => {
    const src = await readFile(new URL('../src/monitor/ActiveExecutionSweeper.ts', import.meta.url), 'utf8')
    expect(src).toContain('300_000')
  })
})
