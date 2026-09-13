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

  it('propaga atualização de entrega do chat com seus identificadores', () => {
    const bus = new ExecutionEventBus()
    const handler = vi.fn()
    bus.on(handler)
    const event = {
      type: 'task.chat.delivery.updated' as const,
      executionId: 'exec-chat', taskId: 'task-chat', phase: 'execute' as const,
      messageId: 41, deliveryId: 7, deliveryState: 'consumed' as const,
      timestamp: new Date(),
    }

    bus.publish(event)

    expect(handler).toHaveBeenCalledWith(event)
  })

  it('aceita o ciclo explícito de checkpoint, espera e retomada', () => {
    const bus = new ExecutionEventBus()
    const handler = vi.fn()
    bus.on(handler)
    const base = {
      executionId: 'exec-interaction', taskId: 'task-interaction', phase: 'execute' as const,
      interactionPhase: 'development' as const, timestamp: new Date(),
    }

    bus.publish({ ...base, type: 'task.interaction.checkpoint_requested' as const })
    bus.publish({ ...base, type: 'task.interaction.awaiting' as const, interactionSummary: 'Aguardando decisão' })
    bus.publish({ ...base, type: 'task.interaction.resumed' as const })

    expect(handler).toHaveBeenCalledTimes(3)
    expect(handler.mock.calls.map(([event]) => event.type)).toEqual([
      'task.interaction.checkpoint_requested', 'task.interaction.awaiting', 'task.interaction.resumed',
    ])
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ interactionSummary: 'Aguardando decisão' })
  })
})
