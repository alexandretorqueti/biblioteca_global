import { describe, expect, it, vi } from 'vitest'
import { CatalogAdminService, CatalogValidationError } from '../src/catalog/CatalogAdminService.js'

const action = (id: number, terminal = false) => ({ id, code: `A${id}`, name: `Ação ${id}`, primitivesJson: [{ primitive: 'log' }], onPartialFailure: 'continue', compensationActionId: null, isTerminal: terminal ? 1 : 0, version: 1, active: 1 })

function dbMock() {
  const rows: Record<string, any[]> = {
    events: [{ id: 1, code: 'E1', name: 'Erro', category: 'erro', scope: 'tarefa', priority: 1, active: 1 }],
    patterns: [{ id: 2, eventId: 1, pattern: 'boom', matchType: 'contains', matchTarget: 'message', active: 1 }],
    actions: [action(3, true)],
    reactions: [{ id: 4, eventId: 1, occurrence: 1, actionId: 3, paramsJson: null, conditionJson: null, version: 1, active: 1 }],
  }
  const table = (name: string) => ({ __name: name })
  const sourceName = (source: any) => source.__name ?? source[Symbol.for('drizzle:Name')] ?? ''
  const db: any = {
    select: vi.fn(() => ({ from: vi.fn((source: any) => ({ where: vi.fn(() => ({ limit: vi.fn(async () => rows[sourceName(source)] ?? []) })), limit: vi.fn(async () => rows[sourceName(source)] ?? []) })) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => [{ insertId: 9 }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    _rows: rows,
  }
  return { db, table }
}

function makeService() {
  const { db } = dbMock()
  const loader: any = {
    load: vi.fn(async () => ({
      events: [{ id: 1, code: 'E1', name: 'Erro', category: 'erro', scope: 'tarefa', priority: 1, active: true }],
      patterns: [{ id: 2, eventId: 1, pattern: 'boom', matchType: 'contains', matchTarget: 'message', active: true }],
      actions: [{ id: 3, code: 'A3', name: 'Ação', primitives: [{ primitive: 'log' }], onPartialFailure: 'continue', compensationActionId: null, isTerminal: true, version: 1, active: true }],
      reactions: [{ id: 4, eventId: 1, occurrence: 1, actionId: 3, params: undefined, condition: undefined, version: 1, active: true }],
      loadedAt: new Date(),
    })),
    clearCache: vi.fn(),
  }
  const executor: any = { getRegisteredPrimitives: () => ['log'] }
  const bus: any = { send: vi.fn() }
  return { service: new CatalogAdminService(db, loader, executor, bus), db, loader, bus }
}

describe('CatalogAdminService', () => {
  it('simula sem incrementar ocorrências ou executar primitivas', async () => {
    const { service: admin, db } = makeService()
    const result = await admin.simulate({ error: { message: 'boom' }, occurrence: 1 })
    expect(result.matched).toBe(true)
    expect(result.wouldExecute).toBe(false)
    expect(result.primitives).toEqual([{ primitive: 'log' }])
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('rejeita ação com primitiva não registrada', async () => {
    const { service: admin } = makeService()
    await expect(admin.create('actions', { code: 'BAD', name: 'Inválida', primitives: [{ primitive: 'missing' }] }, 'tester')).rejects.toBeInstanceOf(CatalogValidationError)
  })

  it('rejeita regex inválida e referência inativa', async () => {
    const { service: admin } = makeService()
    await expect(admin.create('patterns', { eventId: 1, pattern: '[', matchType: 'regex', matchTarget: 'message' }, 'tester')).rejects.toBeInstanceOf(CatalogValidationError)
    await expect(admin.create('reactions', { eventId: 999, occurrence: 1, actionId: 3 }, 'tester')).rejects.toBeInstanceOf(CatalogValidationError)
  })
})
