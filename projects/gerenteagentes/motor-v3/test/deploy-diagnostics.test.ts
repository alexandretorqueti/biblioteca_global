import { describe, expect, it, vi } from 'vitest'
import { getDeployDiagnostics } from '../src/deploy/DeployDiagnostics.js'

describe('getDeployDiagnostics', () => {
  it('autoriza o dispatch quando há solicitação pendente sem impedimentos', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ pending: 2, running: 0 }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ total: 0 }]]),
    } as any

    await expect(getDeployDiagnostics(pool)).resolves.toEqual({
      canStart: true,
      pendingRequests: 2,
      reasons: ['deploy pronto para iniciar'],
    })
  })

  it('informa deploys em andamento e tarefas ativas', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ pending: 0, running: 1 }]])
        .mockResolvedValueOnce([[{ task_id: 'task-p6-850' }]])
        .mockResolvedValueOnce([[{ total: 0 }]]),
    } as any

    await expect(getDeployDiagnostics(pool)).resolves.toEqual({
      canStart: false,
      pendingRequests: 0,
      reasons: ['1 deploy(s) em andamento', 'tarefas ativas: task-p6-850'],
    })
  })
})
// @vitest-environment node
