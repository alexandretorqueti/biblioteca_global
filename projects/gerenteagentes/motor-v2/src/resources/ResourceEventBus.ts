/**
 * ResourceEventBus - Barramento de eventos de recursos
 * 
 * Publica e assina eventos relacionados a recursos:
 * - acquired: recurso foi adquirido
 * - released: recurso foi liberado
 * - expired: recurso expirou
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
    // Aumenta limite de listeners para evitar warnings
    this.emitter.setMaxListeners(100)
  }

  /**
   * Publica um evento
   */
  publish(event: ResourceEvent): void {
    this.emitter.emit(event.type, event)
    this.emitter.emit('any', event)
  }

  /**
   * Assina eventos de um tipo específico
   */
  on(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.on(type, handler)
  }

  /**
   * Assina todos os eventos
   */
  onAny(handler: ResourceEventHandler): void {
    this.emitter.on('any', handler)
  }

  /**
   * Remove handler
   */
  off(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.off(type, handler)
  }

  /**
   * Assina evento uma única vez
   */
  once(type: ResourceEventType, handler: ResourceEventHandler): void {
    this.emitter.once(type, handler)
  }

  /**
   * Aguarda um evento específico
   */
  waitFor(type: ResourceEventType, resourceKey: ResourceKey, timeoutMs = 30000): Promise<ResourceEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.emitter.off(type, handler)
        reject(new Error(`Timeout aguardando evento ${type} para ${resourceKey}`))
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

// Singleton
export const resourceEventBus = new ResourceEventBus()
