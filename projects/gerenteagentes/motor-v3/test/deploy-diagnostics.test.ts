import { describe, expect, it, vi } from 'vitest'
import { getDeployDiagnostics } from '../src/deploy/DeployDiagnostics.js'

describe('getDeployDiagnostics', () => {
  it('expõe solicitações pendentes sem autorizar deploy no v3', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ pending: 2, running: 0 }]])
        .mockResolvedValueOnce([[]]),
    } as any

    await expect(getDeployDiagnostics(pool)).resolves.toEqual({
      canStart: false,
      pendingRequests: 2,
      reasons: ['executor de deploy ainda não habilitado no Motor v3'],
    })
  })

  it('informa deploys em andamento e tarefas ativas', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ pending: 0, running: 1 }]])
        .mockResolvedValueOnce([[{ task_id: 'task-p6-850' }]]),
    } as any

    await expect(getDeployDiagnostics(pool)).resolves.toEqual({
      canStart: false,
      pendingRequests: 0,
      reasons: ['1 deploy(s) em andamento', 'tarefas ativas: task-p6-850'],
    })
  })
})
