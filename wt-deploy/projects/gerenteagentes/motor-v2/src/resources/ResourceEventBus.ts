/**
 * ResourceEventBus - Barramento de eventos de recursos
 */

import { EventEmitter } from 'node:events'
import type { ResourceKey } from '../shared/types/resources.js'

export type ResourceEventType = 'acquired' | 'released' | 'expired'

export interface ResourceEvent {
  type: ResourceEventType
  resourceKey: ResourceKey
  executionId: string
  ownerId?: string
  timestamp: Date
}

export type ResourceEventHandler = (event: ResourceEvent) => void | Promise<void>

export class ResourceEventBus {
  private emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(100)
  }

  publish(event: ResourceEvent): void {
    this.emitter.emit(event.type, event)
    this.emitter.emit('any', event)
  }

  on(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.on(type, handler)
  }

  onAny(handler: ResourceEventHandler): void {
    this.emitter.on('any', handler)
  }

  off(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.off(type, handler)
  }

  once(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.once(type, handler)
  }

  waitFor(type: ResourceEventType, resourceKey: ResourceKey, timeoutMs = 30000): Promise<ResourceEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.emitter.off(type, handler)
        reject(new Error(`Timeout: ${type} para ${resourceKey}`))
      }, timeoutMs)

      const handler = (event: ResourceEvent) => {
        if (event.resourceKey === resourceKey) {
          clearTimeout(timeout)
          this.emitter.off(type, handler)
          resolve(event)
        }
      }

      this.emitter.on(type, handler)
    })
  }
}

export const resourceEventBus = new ResourceEventBus()
