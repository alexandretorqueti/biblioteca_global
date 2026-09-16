import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MonitorBridge } from '../src/monitor-bridge/MonitorBridge.js'
import type { MessageBus } from '../src/bus/index.js'
import type { CatalogLoader } from '../src/catalog/index.js'
import type { EventClassifier } from '../src/classifier/index.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

describe('MonitorBridge', () => {
  let monitorBridge: MonitorBridge
  let mockBus: MessageBus
  let mockLoader: CatalogLoader
  let mockClassifier: EventClassifier
  let mockContext: PrimitiveContext

  beforeEach(() => {
    mockBus = {
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      subscribe: vi.fn(),
      use: vi.fn(),
      debug: vi.fn().mockReturnValue({ typeHandlers: {}, topicHandlers: {} }),
      reset: vi.fn(),
    } as any

    mockLoader = {
      load: vi.fn().mockResolvedValue({
        events: [],
        patterns: [],
        actions: [],
        reactions: [],
        loadedAt: new Date(),
      }),
      reload: vi.fn(),
      getEventByCode: vi.fn(),
      getPatternsForEvent: vi.fn(),
      getActionById: vi.fn(),
      getReactionsForEvent: vi.fn(),
      clearCache: vi.fn(),
    } as any

    mockClassifier = {
      classify: vi.fn().mockResolvedValue(null), // Simula erro não catalogado
    } as any

    monitorBridge = new MonitorBridge(mockBus, mockLoader, mockClassifier, {
      monitorModel: 'gpt-5.6-sol',
      telegramTarget: '7147090795',
      autoActivateCaseA: true,
    })

    mockContext = {
      taskId: 'task-123',
      subtaskId: 456,
      executionId: 'exec-789',
      generation: 1,
      projectSlug: 'test-project',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      branchName: 'motor-v3/task-123/sub-456/a1',
      agentId: 'test-agent',
      db: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  describe('handleUncataloguedError', () => {
    it('should throw error when error is already catalogued', async () => {
      mockClassifier.classify.mockResolvedValue({
        event: { id: 1, code: 'E01' },
        occurrence: 1,
        reaction: { id: 1, actionId: 1 },
        action: { id: 1, code: 'A01' },
      })

      await expect(
        monitorBridge.handleUncataloguedError(mockContext, { message: 'test' })
      ).rejects.toThrow('Erro já catalogado, não requer Monitor')
    })

    it('should invoke monitor for uncatalogued error', async () => {
      const result = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      expect(result.proposalId).toBeDefined()
      expect(result.case).toBe('B') // Mock retorna Caso B
    })

    it('should emit CATALOG_ENTRY_PROPOSED event for Caso B', async () => {
      await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CATALOG_ENTRY_PROPOSED',
          taskId: 'task-123',
          subtaskId: 456,
        })
      )
    })
  })

  describe('approveProposal', () => {
    it('should approve pending proposal', async () => {
      const { proposalId } = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      await monitorBridge.approveProposal(proposalId, 'admin')

      const proposal = monitorBridge.getProposal(proposalId)
      expect(proposal?.status).toBe('approved')
      expect(proposal?.reviewedBy).toBe('admin')
      expect(proposal?.reviewedAt).toBeInstanceOf(Date)
    })

    it('should emit CATALOG_ENTRY_APPROVED event', async () => {
      const { proposalId } = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      await monitorBridge.approveProposal(proposalId, 'admin')

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CATALOG_ENTRY_APPROVED',
          taskId: 'task-123',
          payload: expect.objectContaining({
            proposalId,
            reviewedBy: 'admin',
          }),
        })
      )
    })

    it('should throw error when proposal not found', async () => {
      await expect(
        monitorBridge.approveProposal('non-existent', 'admin')
      ).rejects.toThrow('Proposal non-existent not found')
    })
  })

  describe('rejectProposal', () => {
    it('should reject pending proposal', async () => {
      const { proposalId } = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      await monitorBridge.rejectProposal(proposalId, 'admin', 'Not relevant')

      const proposal = monitorBridge.getProposal(proposalId)
      expect(proposal?.status).toBe('rejected')
      expect(proposal?.reviewedBy).toBe('admin')
    })

    it('should emit CATALOG_ENTRY_REJECTED event', async () => {
      const { proposalId } = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Unknown error',
      })

      await monitorBridge.rejectProposal(proposalId, 'admin', 'Not relevant')

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CATALOG_ENTRY_REJECTED',
          payload: expect.objectContaining({
            proposalId,
            reviewedBy: 'admin',
            reason: 'Not relevant',
          }),
        })
      )
    })
  })

  describe('getPendingProposals', () => {
    it('should return only pending proposals', async () => {
      await monitorBridge.handleUncataloguedError(mockContext, { message: 'Error 1' })
      const { proposalId } = await monitorBridge.handleUncataloguedError(mockContext, {
        message: 'Error 2',
      })

      await monitorBridge.approveProposal(proposalId, 'admin')

      const pending = monitorBridge.getPendingProposals()
      expect(pending).toHaveLength(1)
      expect(pending[0].status).toBe('pending')
    })
  })
})
