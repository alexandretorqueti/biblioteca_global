import { EventEmitter } from 'node:events'
import type { ExecutionPhase } from '../shared/types/execution.js'

export type ExecutionActivityType = 'started' | 'progress' | 'log' | 'heartbeat' | 'completed' | 'failed' | 'model_unavailable' | 'developer_branch_integrated'

export interface ExecutionActivityEvent {
  type: ExecutionActivityType
  executionId: string
  taskId: string
  subtaskId?: number
  phase: 'analyze' | 'execute'
  executionPhase?: ExecutionPhase
  level?: 'info' | 'warn' | 'error'
  message?: string
  model?: string
  timestamp: Date
}

export interface ExecutionActivityBroadcaster {
  publish(event: ExecutionActivityEvent): void | Promise<void>
}

export class ExecutionEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  publish(event: ExecutionActivityEvent): void {
    this.emitter.emit('activity', event)
  }

  on(handler: (event: ExecutionActivityEvent) => void | Promise<void>): void {
    this.emitter.on('activity', handler)
  }

  off(handler: (event: ExecutionActivityEvent) => void | Promise<void>): void {
    this.emitter.off('activity', handler)
  }
}

export const executionEventBus = new ExecutionEventBus()
