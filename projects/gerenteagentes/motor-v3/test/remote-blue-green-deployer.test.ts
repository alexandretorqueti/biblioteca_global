import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))

import { RemoteBlueGreenDeployer } from '../src/deploy/RemoteBlueGreenDeployer.js'

describe('RemoteBlueGreenDeployer.status', () => {
  beforeEach(() => execFile.mockReset())

  function probe(output: string) {
    execFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: Function) => callback(null, { stdout: output, stderr: '' }))
    return new RemoteBlueGreenDeployer('deploy@host').status('/tmp/biblioteca-global-deploy-5cc1529b.status', '1234')
  }

  it('aceita somente success como terminal de sucesso', async () => {
    await expect(probe('process=absent\nstatus=success\nlog=ok')).resolves.toMatchObject({ state: 'success', status: 'success' })
  })

  it('aceita failed:<codigo> e preserva diagnóstico limitado', async () => {
    await expect(probe('process=absent\nstatus=failed:1\nlog=falha no health check')).resolves.toMatchObject({ state: 'failed', status: 'failed:1', diagnostic: 'falha no health check' })
  })

  it('distingue processo ativo de status inválido ou ausente', async () => {
    await expect(probe('process=active\nstatus=running\nlog=em andamento')).resolves.toMatchObject({ state: 'active', status: null })
    await expect(probe('process=absent\nstatus=done\nlog=resultado desconhecido')).resolves.toMatchObject({ state: 'invalid', status: 'done' })
    await expect(probe('process=absent\nstatus=\nlog=')).resolves.toMatchObject({ state: 'absent', status: null, diagnostic: 'processo remoto ausente sem status terminal' })
  })

  it('limita o diagnóstico remoto', async () => {
    const result = await probe(`process=absent\nstatus=failed:1\nlog=${'x'.repeat(5000)}`)
    expect(result.diagnostic).toHaveLength(4000)
  })
})
