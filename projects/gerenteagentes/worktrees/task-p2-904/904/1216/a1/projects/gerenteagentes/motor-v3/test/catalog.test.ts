import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CatalogLoader } from '../src/catalog/CatalogLoader.js'
import type { MessageBus } from '../src/bus/MessageBus.js'

// Mock DB - simula queries retornando dados na ordem das chamadas
const createMockDb = (data: {
  events?: any[]
  patterns?: any[]
  actions?: any[]
  reactions?: any[]
}) => {
  // Catálogo carrega nessa ordem: events, patterns, actions, reactions
  const tableOrder = [
    data.events || [],
    data.patterns || [],
    data.actions || [],
    data.reactions || []
  ]
  
  let callCount = 0

  const mockFrom = vi.fn().mockImplementation(() => {
    const currentIndex = callCount
    callCount++
    
    return { 
      where: vi.fn().mockResolvedValue(tableOrder[currentIndex] || []) 
    }
  })

  return {
    select: vi.fn().mockReturnValue({ from: mockFrom }),
    _data: data,
    _resetCallCount: () => { callCount = 0 },
  }
}

// Mock MessageBus
const createMockBus = (): MessageBus => ({
  on: vi.fn(),
  off: vi.fn(),
  send: vi.fn(),
  emit: vi.fn(),
  subscribe: vi.fn(),
  use: vi.fn(),
  debug: vi.fn().mockReturnValue({ typeHandlers: {}, topicHandlers: {} }),
  reset: vi.fn(),
}) as any

describe('CatalogLoader', () => {
  let loader: CatalogLoader
  let mockDb: any
  let mockBus: MessageBus

  beforeEach(() => {
    mockDb = createMockDb({
      events: [
        { id: 1, code: 'E01', name: 'Estouro de Contexto', category: 'erro', scope: 'subtarefa', priority: 10, active: 1 },
        { id: 2, code: 'E02', name: 'Modelo Indisponível', category: 'erro', scope: 'subtarefa', priority: 20, active: 1 },
      ],
      patterns: [
        { id: 1, eventId: 1, pattern: 'context overflow', matchType: 'contains', matchTarget: 'message', active: 1 },
        { id: 2, eventId: 2, pattern: 'model_unavailable', matchType: 'contains', matchTarget: 'code', active: 1 },
      ],
      actions: [
        { id: 1, code: 'A01_SANITIZE', name: 'Saneamento', primitivesJson: [{ primitive: 'archive_session' }], onPartialFailure: 'continue', compensationActionId: null, isTerminal: 0, active: 1 },
        { id: 2, code: 'A02_ESCALATE', name: 'Escalada', primitivesJson: [{ primitive: 'escalate_model' }], onPartialFailure: 'continue', compensationActionId: null, isTerminal: 0, active: 1 },
      ],
      reactions: [
        { id: 1, eventId: 1, occurrence: 1, actionId: 1, paramsJson: null, active: 1 },
        { id: 2, eventId: 1, occurrence: 2, actionId: 2, paramsJson: null, active: 1 },
      ],
    })

    mockBus = createMockBus()
    loader = new CatalogLoader(mockDb, mockBus)
  })

  it('should load catalog on first call', async () => {
    const catalog = await loader.load()

    expect(catalog.events).toHaveLength(2)
    expect(catalog.patterns).toHaveLength(2)
    expect(catalog.actions).toHaveLength(2)
    expect(catalog.reactions).toHaveLength(2)
    expect(catalog.loadedAt).toBeInstanceOf(Date)
  })

  it('should use cache on subsequent calls', async () => {
    await loader.load()
    await loader.load()

    // select should only be called 4 times (once per table) on first load
    expect(mockDb.select).toHaveBeenCalledTimes(4)
  })

  it('should reload when CATALOG_CHANGED event is received', async () => {
    const busOn = mockBus.on as any
    let catalogChangedHandler: any

    busOn.mockImplementation((event: string, handler: any) => {
      if (event === 'CATALOG_CHANGED') {
        catalogChangedHandler = handler
      }
    })

    loader = new CatalogLoader(mockDb, mockBus)
    await loader.load()

    // Trigger reload
    await catalogChangedHandler()

    // select should be called 8 times total (4 for initial load + 4 for reload)
    expect(mockDb.select).toHaveBeenCalledTimes(8)
  })

  it('should get event by code', async () => {
    await loader.load()
    const event = await loader.getEventByCode('E01')

    expect(event).toBeDefined()
    expect(event?.code).toBe('E01')
    expect(event?.name).toBe('Estouro de Contexto')
  })

  it('should return undefined for non-existent event code', async () => {
    await loader.load()
    const event = await loader.getEventByCode('E99')

    expect(event).toBeUndefined()
  })

  it('should get patterns for event', async () => {
    await loader.load()
    const patterns = await loader.getPatternsForEvent(1)

    expect(patterns).toHaveLength(1)
    expect(patterns[0].pattern).toBe('context overflow')
  })

  it('should get action by id', async () => {
    await loader.load()
    const action = await loader.getActionById(1)

    expect(action).toBeDefined()
    expect(action?.code).toBe('A01_SANITIZE')
    expect(action?.primitives).toHaveLength(1)
  })

  it('should get reactions for event sorted by occurrence', async () => {
    await loader.load()
    const reactions = await loader.getReactionsForEvent(1)

    expect(reactions).toHaveLength(2)
    expect(reactions[0].occurrence).toBe(1)
    expect(reactions[1].occurrence).toBe(2)
  })

  it('should clear cache', async () => {
    await loader.load()
    loader.clearCache()
    await loader.load()

    // select should be called 8 times (4 for first load + 4 for second load after clear)
    expect(mockDb.select).toHaveBeenCalledTimes(8)
  })
})
// @vitest-environment node
