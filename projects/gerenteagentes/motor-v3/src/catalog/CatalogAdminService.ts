import { and, eq } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import * as schema from '../db/schema.js'
import type { MessageBus } from '../bus/MessageBus.js'
import type { ActionExecutor } from '../executor/ActionExecutor.js'
import { RuleEvaluator, type RuleContext } from '../governance/RuleEvaluator.js'
import type { CatalogLoader, CatalogAction, CatalogEvent, CatalogPattern, CatalogReaction } from './CatalogLoader.js'

export type CatalogEntity = 'events' | 'patterns' | 'actions' | 'reactions'

export interface CatalogSimulationInput {
  error: { code?: string; message?: string; stack?: string; actionResult?: string }
  taskId?: string
  subtaskId?: number | null
  generation?: number
  occurrence?: number
  context?: Record<string, unknown>
}

export interface CatalogSimulationResult {
  matched: boolean
  event: CatalogEvent | null
  occurrence: number
  reaction: CatalogReaction | null
  action: CatalogAction | null
  primitives: Array<{ primitive: string; params?: Record<string, any> }>
  wouldExecute: false
}

export class CatalogValidationError extends Error {
  statusCode = 400
}

export class CatalogNotFoundError extends Error {
  statusCode = 404
}

type Db = MySql2Database<typeof schema>

/** Operações administrativas do catálogo. Não executa primitivas. */
export class CatalogAdminService {
  private readonly evaluator = new RuleEvaluator()

  constructor(
    private readonly db: Db,
    private readonly loader: CatalogLoader,
    private readonly executor: ActionExecutor,
    private readonly bus?: MessageBus,
  ) {}

  async list(entity: CatalogEntity): Promise<unknown[]> {
    const table = this.table(entity)
    return this.db.select().from(table as any).limit(200) as any
  }

  async create(entity: CatalogEntity, payload: Record<string, any>, actor: string): Promise<unknown> {
    const values = await this.normalizeAndValidate(entity, payload)
    const result = await this.db.insert(this.table(entity) as any).values(values as any)
    const id = Number((result as any)[0]?.insertId ?? 0)
    await this.audit(actor, 'create', entity, id, values)
    await this.invalidate()
    return id > 0 ? { id, ...values } : values
  }

  async update(entity: CatalogEntity, id: number, payload: Record<string, any>, actor: string): Promise<unknown> {
    const current = await this.get(entity, id) as any
    const merged = { ...(current as Record<string, any>), ...payload }
    if (payload.active === false || payload.active === 0) {
      return this.deactivate(entity, id, actor)
    }
    if (entity === 'actions' && current.isTerminal === 1 && !merged.isTerminal) {
      await this.assertTerminalInvariantForAction(id)
    }
    if (entity === 'reactions' && Number(current.actionId) !== Number(payload.actionId ?? current.actionId)) {
      const currentAction = await this.get('actions', Number(current.actionId)) as any
      const nextAction = await this.get('actions', Number(payload.actionId ?? current.actionId)) as any
      if (currentAction.isTerminal === 1 && nextAction.isTerminal !== 1) await this.assertTerminalInvariantForReaction(current)
    }
    const values = await this.normalizeAndValidate(entity, merged, id)
    await this.db.update(this.table(entity) as any).set(values as any).where(eq((this.table(entity) as any).id, id))
    await this.audit(actor, 'update', entity, id, values)
    await this.invalidate()
    return { id, ...values }
  }

  async deactivate(entity: CatalogEntity, id: number, actor: string): Promise<unknown> {
    const current = await this.get(entity, id)
    if (entity === 'actions') await this.assertTerminalInvariantForAction(id)
    if (entity === 'reactions') await this.assertTerminalInvariantForReaction(current as any)
    await this.db.update(this.table(entity) as any).set({ active: 0 }).where(eq((this.table(entity) as any).id, id))
    await this.audit(actor, 'deactivate', entity, id, { active: 0 })
    await this.invalidate()
    return { id, active: false }
  }

  async simulate(input: CatalogSimulationInput): Promise<CatalogSimulationResult> {
    const catalog = await this.loader.load()
    const occurrence = Number.isInteger(input.occurrence) && Number(input.occurrence) > 0 ? Number(input.occurrence) : 1
    const events = [...catalog.events].sort((a, b) => a.priority - b.priority)
    const error = input.error ?? {}
    const ruleContext: RuleContext = {
      ...(input.context ?? {}),
      error: error as Record<string, unknown>,
      context: input.context,
      occurrence,
    }

    for (const event of events) {
      const patterns = catalog.patterns.filter(pattern => pattern.eventId === event.id)
      const matched = patterns.some(pattern => {
        const value = error[pattern.matchTarget === 'action_result' ? 'actionResult' : pattern.matchTarget]
        return typeof value === 'string' && this.matchPattern(value, pattern.pattern, pattern.matchType)
      })
      if (!matched) continue

      const reactions = catalog.reactions
        .filter(reaction => reaction.eventId === event.id)
        .filter(reaction => this.evaluator.evaluate(reaction.condition, ruleContext))
        .sort((a, b) => a.occurrence - b.occurrence)
      const reaction = reactions.find(item => item.occurrence === occurrence) ?? reactions[reactions.length - 1] ?? null
      const action = reaction ? catalog.actions.find(item => item.id === reaction.actionId) ?? null : null
      return { matched: true, event, occurrence, reaction, action, primitives: action?.primitives ?? [], wouldExecute: false }
    }

    return { matched: false, event: null, occurrence, reaction: null, action: null, primitives: [], wouldExecute: false }
  }

  private table(entity: CatalogEntity): any {
    const tables = { events: schema.motorEvents, patterns: schema.motorPatterns, actions: schema.motorActions, reactions: schema.motorReactions }
    const table = tables[entity]
    if (!table) throw new CatalogValidationError(`Entidade de catálogo inválida: ${entity}`)
    return table
  }

  async get(entity: CatalogEntity, id: number): Promise<unknown> {
    if (!Number.isInteger(id) || id <= 0) throw new CatalogValidationError('Identificador inválido')
    const rows = await this.db.select().from(this.table(entity) as any).where(eq((this.table(entity) as any).id, id)).limit(1) as any[]
    if (!rows[0]) throw new CatalogNotFoundError(`${entity}/${id} não encontrado`)
    return rows[0]
  }

  private async normalizeAndValidate(entity: CatalogEntity, payload: Record<string, any>, id?: number): Promise<Record<string, any>> {
    if (entity === 'events') {
      const values = { code: String(payload.code ?? ''), name: String(payload.name ?? ''), category: payload.category, scope: payload.scope ?? 'subtarefa', priority: Number(payload.priority ?? 100), active: payload.active === false ? 0 : 1 }
      if (!values.code || !values.name || !['erro', 'verificacao', 'conclusao', 'estado', 'humano', 'infra'].includes(values.category) || !['global', 'projeto', 'tarefa', 'subtarefa'].includes(values.scope) || !Number.isInteger(values.priority) || values.priority < 0) throw new CatalogValidationError('Evento inválido')
      await this.assertUnique(entity, 'code', values.code, id)
      return values
    }
    if (entity === 'patterns') {
      const values = { eventId: Number(payload.eventId), pattern: String(payload.pattern ?? ''), matchType: payload.matchType ?? 'contains', matchTarget: payload.matchTarget ?? 'message', active: payload.active === false ? 0 : 1 }
      const event = await this.get('events', values.eventId).catch(() => null) as any
      if (!event || !event.active || !values.pattern || !['regex', 'contains', 'exact'].includes(values.matchType) || !['code', 'message', 'stack', 'action_result'].includes(values.matchTarget)) throw new CatalogValidationError('Padrão inválido ou evento inativo')
      if (values.matchType === 'regex') { try { new RegExp(values.pattern) } catch { throw new CatalogValidationError('Regex inválida') } }
      return values
    }
    if (entity === 'actions') {
      const primitives = payload.primitivesJson ?? payload.primitives
      const values = { code: String(payload.code ?? ''), name: String(payload.name ?? ''), primitivesJson: primitives, onPartialFailure: payload.onPartialFailure ?? 'continue', compensationActionId: payload.compensationActionId == null ? null : Number(payload.compensationActionId), isTerminal: payload.isTerminal ? 1 : 0, version: Number(payload.version ?? 1), active: payload.active === false ? 0 : 1 }
      const registered = new Set(this.executor.getRegisteredPrimitives())
      if (!values.code || !values.name || !Array.isArray(values.primitivesJson) || values.primitivesJson.length === 0 || values.primitivesJson.some((item: any) => !item || typeof item.primitive !== 'string' || !registered.has(item.primitive)) || !['continue', 'compensate', 'mark_dirty'].includes(values.onPartialFailure) || !Number.isInteger(values.version) || values.version < 1) throw new CatalogValidationError('Ação inválida ou contém primitiva não registrada')
      await this.assertUnique(entity, 'code', values.code, id)
      if (values.compensationActionId != null) await this.get('actions', values.compensationActionId)
      return values
    }
    const values = { eventId: Number(payload.eventId), occurrence: Number(payload.occurrence), actionId: Number(payload.actionId), paramsJson: payload.paramsJson ?? payload.params ?? null, conditionJson: payload.conditionJson ?? payload.condition ?? null, version: Number(payload.version ?? 1), active: payload.active === false ? 0 : 1 }
    const event = await this.get('events', values.eventId).catch(() => null) as any
    const action = await this.get('actions', values.actionId).catch(() => null) as any
    if (!event || !event.active || !action || !action.active || !Number.isInteger(values.occurrence) || values.occurrence < 1 || !Number.isInteger(values.version) || values.version < 1 || !this.validCondition(values.conditionJson)) throw new CatalogValidationError('Reação inválida ou com referência inativa')
    if (values.active === 0 && event.category === 'erro') await this.assertTerminalInvariantForReaction({ ...values, id })
    return values
  }

  private async assertUnique(entity: CatalogEntity, field: string, value: string, id?: number): Promise<void> {
    if (entity !== 'events' && entity !== 'actions') return
    const rows = await this.db.select().from(this.table(entity) as any).where(eq((this.table(entity) as any)[field], value)).limit(2) as any[]
    if (rows.some(row => Number(row.id) !== id)) throw new CatalogValidationError(`${field} já cadastrado`)
  }

  private async assertTerminalInvariantForReaction(reaction: any): Promise<void> {
    const event = await this.get('events', Number(reaction.eventId)) as any
    if (event.category !== 'erro') return
    const reactions = await this.db.select().from(schema.motorReactions).where(and(eq(schema.motorReactions.eventId, Number(reaction.eventId)), eq(schema.motorReactions.active, 1))).limit(500) as any[]
    const actions = await this.db.select().from(schema.motorActions).where(eq(schema.motorActions.active, 1)).limit(500) as any[]
    const hasTerminal = reactions.some(item => Number(item.id) !== Number(reaction.id) && actions.some(action => Number(action.id) === Number(item.actionId) && action.isTerminal === 1))
    if (!hasTerminal) throw new CatalogValidationError('Não é permitido remover a última reação terminal de um evento de erro')
  }

  private async assertTerminalInvariantForAction(actionId: number): Promise<void> {
    const reactions = await this.db.select().from(schema.motorReactions).where(and(eq(schema.motorReactions.actionId, actionId), eq(schema.motorReactions.active, 1))).limit(500) as any[]
    const actionEvents = new Set(reactions.map(reaction => Number(reaction.eventId)))
    const activeReactions = await this.db.select().from(schema.motorReactions).where(eq(schema.motorReactions.active, 1)).limit(500) as any[]
    const activeActions = await this.db.select().from(schema.motorActions).where(eq(schema.motorActions.active, 1)).limit(500) as any[]
    for (const eventId of actionEvents) {
      const event = await this.get('events', eventId) as any
      if (event.category === 'erro' && !activeReactions.some(reaction => Number(reaction.eventId) === eventId && Number(reaction.actionId) !== actionId && activeActions.some(action => Number(action.id) === Number(reaction.actionId) && Number(action.id) !== actionId && action.isTerminal === 1))) {
        throw new CatalogValidationError('Não é permitido remover a última reação terminal de um evento de erro')
      }
    }
  }

  private validCondition(condition: unknown): boolean {
    if (condition == null) return true
    if (typeof condition !== 'object' || Array.isArray(condition)) return false
    const rule = condition as any
    if (rule.all !== undefined) return Array.isArray(rule.all) && rule.all.every((item: unknown) => this.validCondition(item))
    if (rule.any !== undefined) return Array.isArray(rule.any) && rule.any.every((item: unknown) => this.validCondition(item))
    return typeof rule.field === 'string'
      && ['eq', 'neq', 'gte', 'lte', 'contains', 'regex'].includes(rule.op)
      && (['string', 'number', 'boolean'].includes(typeof rule.value) || rule.value === null)
      && (rule.op !== 'regex' || (() => { try { new RegExp(String(rule.value)); return true } catch { return false } })())
  }

  private matchPattern(value: string, pattern: string, type: CatalogPattern['matchType']): boolean {
    if (type === 'exact') return value === pattern
    if (type === 'contains') return value.includes(pattern)
    try { return new RegExp(pattern).test(value) } catch { return false }
  }

  private async audit(actor: string, operation: string, entity: CatalogEntity, id: number, payload: Record<string, any>): Promise<void> {
    await this.db.insert(schema.motorCatalogProposals).values({ source: 'human', status: 'approved', diagnosis: `Catálogo: ${operation} ${entity}/${id}`, proposalJson: { actor, operation, entity, id, payload }, tarefaId: 'catalog-admin' })
  }

  private async invalidate(): Promise<void> {
    this.loader.clearCache()
    await this.bus?.send({ type: 'CATALOG_CHANGED', taskId: 'catalog-admin', executionId: `catalog-${Date.now()}`, payload: {}, timestamp: new Date().toISOString() })
  }
}
