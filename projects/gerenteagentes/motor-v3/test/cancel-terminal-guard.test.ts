import { describe, expect, it, vi } from 'vitest'
import { inspectCancelTerminalState, buildAlreadyTerminalCancelResponse } from '../src/coordinator/CancelTerminalGuard.js'

function poolReturning(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue([rows, []])
  return { query }
}

describe('inspectCancelTerminalState', () => {
  it('retorna o terminal_status canônico da combinação da tarefa 1029', async () => {
    const pool = poolReturning([{ terminal_status: 'completed' }])

    const state = await inspectCancelTerminalState(pool as never, 'task-p2-1029')

    expect(state).toEqual({ found: true, terminalStatus: 'completed' })
    expect(pool.query.mock.calls[0]?.[0]).toContain('task_runtime_facts f ON f.tarefa_id = t.id')
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['task-p2-1029', 'task-p2-1029'])
  })

  it('normaliza terminal_status gravado com caixa/espaços divergentes', async () => {
    const pool = poolReturning([{ terminal_status: ' Cancelled ' }])

    await expect(inspectCancelTerminalState(pool as never, '42')).resolves.toEqual({ found: true, terminalStatus: 'cancelled' })
  })

  it('retorna terminalStatus nulo para tarefa existente não terminal (fluxo assíncrono preservado)', async () => {
    const pool = poolReturning([{ terminal_status: null }])

    await expect(inspectCancelTerminalState(pool as never, 'task-p2-1044')).resolves.toEqual({ found: true, terminalStatus: null })
  })

  it('retorna found=false quando a tarefa não existe', async () => {
    const pool = poolReturning([])

    await expect(inspectCancelTerminalState(pool as never, 'task-inexistente')).resolves.toEqual({ found: false, terminalStatus: null })
  })
})

describe('buildAlreadyTerminalCancelResponse', () => {
  it('produz resposta idempotente explícita sem accepted', async () => {
    const response = buildAlreadyTerminalCancelResponse('task-p2-1029', 'completed')

    expect(response).toEqual({
      ok: true,
      accepted: false,
      alreadyTerminal: true,
      taskId: 'task-p2-1029',
      terminalStatus: 'completed',
      message: 'Tarefa já está em estado terminal (completed); nenhum comando de cancelamento foi enfileirado',
    })
  })
})
