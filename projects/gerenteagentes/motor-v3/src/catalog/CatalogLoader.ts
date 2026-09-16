/**
 * CatalogLoader — carrega catálogo do DB com cache e invalidação
 *
 * Cache em memória, invalidado por evento CATALOG_CHANGED no bus.
 * Hot reload sem restart do motor.
 */

import type { MySql2Database } from 'drizzle-orm/mysql2'
import type { MessageBus } from '../bus/MessageBus.js'
import * as schema from '../db/schema.js'
import { eq } from 'drizzle-orm'

export interface CatalogEvent {
  id: number
  code: string
  name: string
  category: string
  scope: string
  priority: number
  active: boolean
}

export interface CatalogPattern {
  id: number
  eventId: number
  pattern: string
  matchType: 'regex' | 'contains' | 'exact'
  matchTarget: 'code' | 'message' | 'stack' | 'action_result'
  active: boolean
}

export interface CatalogAction {
  id: number
  code: string
  name: string
  primitives: Array<{ primitive: string; params?: Record<string, any> }>
  onPartialFailure: 'continue' | 'compensate' | 'mark_dirty'
  compensationActionId: number | null
  isTerminal: boolean
  active: boolean
}

export interface CatalogReaction {
  id: number
  eventId: number
  occurrence: number
  actionId: number
  params?: Record<string, any>
  active: boolean
}

export interface Catalog {
  events: CatalogEvent[]
  patterns: CatalogPattern[]
  actions: CatalogAction[]
  reactions: CatalogReaction[]
  loadedAt: Date
}

export class CatalogLoader {
  private cache: Catalog | null = null
  private db: MySql2Database<typeof schema>
  private bus?: MessageBus

  constructor(db: MySql2Database<typeof schema>, bus?: MessageBus) {
    this.db = db
    this.bus = bus

    // Invalidar cache quando catálogo mudar
    if (bus) {
      bus.on('CATALOG_CHANGED', async () => {
        await this.reload()
      })
    }
  }

  /**
   * Carrega catálogo (usa cache se disponível).
   */
  async load(): Promise<Catalog> {
    if (this.cache) {
      return this.cache
    }
    return this.reload()
  }

  /**
   * Recarrega catálogo do DB (invalida cache).
   */
  async reload(): Promise<Catalog> {
    const events = await this.db.select().from(schema.motorEvents).where(eq(schema.motorEvents.active, 1))
    const patterns = await this.db.select().from(schema.motorPatterns).where(eq(schema.motorPatterns.active, 1))
    const actions = await this.db.select().from(schema.motorActions).where(eq(schema.motorActions.active, 1))
    const reactions = await this.db.select().from(schema.motorReactions).where(eq(schema.motorReactions.active, 1))

    this.cache = {
      events: events.map(e => ({
        id: e.id,
        code: e.code,
        name: e.name,
        category: e.category,
        scope: e.scope,
        priority: e.priority,
        active: e.active === 1,
      })),
      patterns: patterns.map(p => ({
        id: p.id,
        eventId: p.eventId,
        pattern: p.pattern,
        matchType: p.matchType,
        matchTarget: p.matchTarget,
        active: p.active === 1,
      })),
      actions: actions.map(a => ({
        id: a.id,
        code: a.code,
        name: a.name,
        primitives: a.primitivesJson ?? [],
        onPartialFailure: a.onPartialFailure,
        compensationActionId: a.compensationActionId,
        isTerminal: a.isTerminal === 1,
        active: a.active === 1,
      })),
      reactions: reactions.map(r => ({
        id: r.id,
        eventId: r.eventId,
        occurrence: r.occurrence,
        actionId: r.actionId,
        params: r.paramsJson ?? undefined,
        active: r.active === 1,
      })),
      loadedAt: new Date(),
    }

    return this.cache
  }

  /**
   * Busca evento por código.
   */
  async getEventByCode(code: string): Promise<CatalogEvent | undefined> {
    const catalog = await this.load()
    return catalog.events.find(e => e.code === code)
  }

  /**
   * Busca patterns de um evento.
   */
  async getPatternsForEvent(eventId: number): Promise<CatalogPattern[]> {
    const catalog = await this.load()
    return catalog.patterns.filter(p => p.eventId === eventId)
  }

  /**
   * Busca action por ID.
   */
  async getActionById(id: number): Promise<CatalogAction | undefined> {
    const catalog = await this.load()
    return catalog.actions.find(a => a.id === id)
  }

  /**
   * Busca reactions de um evento, ordenadas por occurrence.
   */
  async getReactionsForEvent(eventId: number): Promise<CatalogReaction[]> {
    const catalog = await this.load()
    return catalog.reactions
      .filter(r => r.eventId === eventId)
      .sort((a, b) => a.occurrence - b.occurrence)
  }

  /**
   * Retorna todos os eventos (para API).
   */
  async getAllEvents(): Promise<CatalogEvent[]> {
    const catalog = await this.load()
    return catalog.events
  }

  /**
   * Retorna todas as ações (para API).
   */
  async getAllActions(): Promise<CatalogAction[]> {
    const catalog = await this.load()
    return catalog.actions
  }

  /**
   * Limpa cache (para testes).
   */
  clearCache(): void {
    this.cache = null
  }
}
