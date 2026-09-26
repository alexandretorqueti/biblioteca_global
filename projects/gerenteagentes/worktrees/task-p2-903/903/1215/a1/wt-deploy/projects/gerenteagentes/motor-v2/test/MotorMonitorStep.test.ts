/**
 * Testes do MotorMonitorStep
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MotorMonitorStep } from '../src/steps/MotorMonitorStep.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import type { AgentRuntimeDriver } from '@gerente-agentes/openclaw-runtime-driver'
import type { ExecutionContext } from '../src/shared/types/execution.js'

describe('MotorMonitorStep', () => {
  let step: MotorMonitorStep
  let mockDriver: AgentRuntimeDriver
  let mockResourceLease: ResourceLeaseService
  let mockContext: ExecutionContext

  beforeEach(() => {
    mockDriver = {
      sendMessage: vi.fn(),
      getRunStatus: vi.fn(),
    } as unknown as AgentRuntimeDriver

    mockResourceLease = {
      acquire: vi.fn(),
      renew: vi.fn(),
      release: vi.fn(),
    } as unknown as ResourceLeaseService

    mockContext = {
      executionId: 'exec-123',
      taskId: 'task-456',
      projectSlug: 'test-project',
      phase: 'execute',
      fencingToken: 1,
      startedAt: new Date(),
    }

    step = new MotorMonitorStep(mockDriver, mockResourceLease, {
      maxWaitSeconds: 10,
      maxAttempts: 5,
      heartbeatIntervalMs: 100,
    })
  })

  describe('execute', () => {
    it('deve retornar waiting_resource quando monitor está ocupado', async () => {
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'waiting',
        waitId: 42,
        position: 2,
      })

      const result = await step.execute(
        {
          taskId: 'task-456',
          subtaskId: 'st-1',
          reason: 'Test error',
          evidence: { command: 'npm test', excerpt: 'Error' },
        },
        mockContext
      )

      expect(result.kind).toBe('waiting_resource')
      if (result.kind === 'waiting_resource') {
        expect(result.waitId).toBe(42)
        expect(result.position).toBe(2)
      }
    })

    it('deve executar com sucesso quando monitor está livre', async () => {
      // Mock: acquire bem-sucedido
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'acquired',
        lease: {
          resourceKey: 'motor:monitor',
          executionId: 'exec-123',
          ownerId: 'task-456',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: sendMessage
      vi.mocked(mockDriver.sendMessage).mockResolvedValue({
        ok: true,
        runId: 'run-789',
      })

      // Mock: getRunStatus retorna completed
      vi.mocked(mockDriver.getRunStatus).mockResolvedValue({
        status: 'completed',
      })

      // Mock: renew
      vi.mocked(mockResourceLease.renew).mockResolvedValue({
        kind: 'renewed',
        lease: {
          resourceKey: 'motor:monitor',
          executionId: 'exec-123',
          ownerId: 'task-456',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: release
      vi.mocked(mockResourceLease.release).mockResolvedValue({
        kind: 'released',
      })

      const result = await step.execute(
        {
          taskId: 'task-456',
          subtaskId: 'st-1',
          reason: 'Test error',
          evidence: { command: 'npm test', excerpt: 'Error' },
        },
        mockContext
      )

      expect(result.kind).toBe('success')
      if (result.kind === 'success') {
        expect(result.runId).toBe('run-789')
      }

      // Deve ter liberado o recurso
      expect(mockResourceLease.release).toHaveBeenCalled()
    })

    it('deve retornar failed quando acquire é negado', async () => {
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'denied',
        reason: 'Database error',
      })

      const result = await step.execute(
        {
          taskId: 'task-456',
          subtaskId: 'st-1',
          reason: 'Test error',
          evidence: { command: 'npm test', excerpt: 'Error' },
        },
        mockContext
      )

      expect(result.kind).toBe('failed')
      if (result.kind === 'failed') {
        expect(result.reason).toContain('Database error')
      }
    })

    it('deve retornar failed quando lease é perdido durante execução', async () => {
      // Mock: acquire bem-sucedido
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'acquired',
        lease: {
          resourceKey: 'motor:monitor',
          executionId: 'exec-123',
          ownerId: 'task-456',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: sendMessage
      vi.mocked(mockDriver.sendMessage).mockResolvedValue({
        ok: true,
        runId: 'run-789',
      })

      // Mock: renew retorna lost
      vi.mocked(mockResourceLease.renew).mockResolvedValue({
        kind: 'lost',
        reason: 'Lease expirado',
      })

      // Mock: release
      vi.mocked(mockResourceLease.release).mockResolvedValue({
        kind: 'released',
      })

      const result = await step.execute(
        {
          taskId: 'task-456',
          subtaskId: 'st-1',
          reason: 'Test error',
          evidence: { command: 'npm test', excerpt: 'Error' },
        },
        mockContext
      )

      expect(result.kind).toBe('failed')
      if (result.kind === 'failed') {
        expect(result.reason).toContain('Lease perdido')
      }
    })

    it('deve retornar timeout quando monitor não completa a tempo', async () => {
      // Mock: acquire bem-sucedido
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'acquired',
        lease: {
          resourceKey: 'motor:monitor',
          executionId: 'exec-123',
          ownerId: 'task-456',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: sendMessage
      vi.mocked(mockDriver.sendMessage).mockResolvedValue({
        ok: true,
        runId: 'run-789',
      })

      // Mock: getRunStatus sempre retorna running
      vi.mocked(mockDriver.getRunStatus).mockResolvedValue({
        status: 'running',
      })

      // Mock: renew
      vi.mocked(mockResourceLease.renew).mockResolvedValue({
        kind: 'renewed',
        lease: {
          resourceKey: 'motor:monitor',
          executionId: 'exec-123',
          ownerId: 'task-456',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: release
      vi.mocked(mockResourceLease.release).mockResolvedValue({
        kind: 'released',
      })

      const result = await step.execute(
        {
          taskId: 'task-456',
          subtaskId: 'st-1',
          reason: 'Test error',
          evidence: { command: 'npm test', excerpt: 'Error' },
        },
        mockContext
      )

      expect(result.kind).toBe('timeout')
    })
  })
})
