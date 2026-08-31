import { describe, expect, it, vi } from 'vitest'
import { ExecutionEventBus } from '../src/events/ExecutionEventBus.js'

describe('ExecutionEventBus', () => {
  it('propaga evento com correlação sem acoplar ao RealtimeGateway', () => {
    const bus = new ExecutionEventBus()
    const handler = vi.fn()
    bus.on(handler)
    const event = {
      type: 'progress' as const,
      executionId: 'exec-1',
      taskId: 'task-1',
      subtaskId: 9,
      phase: 'execute' as const,
      executionPhase: 'verify' as const,
      message: 'Testes em execução',
      timestamp: new Date(),
    }

    bus.publish(event)

    expect(handler).toHaveBeenCalledWith(event)
  })

  it('propaga indisponibilidade com o modelo afetado', () => {
    const bus = new ExecutionEventBus()
    const handler = vi.fn()
    bus.on(handler)
    const event = {
      type: 'model_unavailable' as const,
      executionId: 'exec-2',
      taskId: 'task-2',
      subtaskId: 10,
      phase: 'execute' as const,
      level: 'warn' as const,
      model: 'provider/model-a',
      message: 'Modelo indisponível: provider/model-a',
      timestamp: new Date(),
    }

    bus.publish(event)

    expect(handler).toHaveBeenCalledWith(event)
  })
})
