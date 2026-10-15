// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEnvironmentPreparer } from '../src/testing/WorkspaceEnvironmentPreparer.js'

describe('WorkspaceEnvironmentPreparer', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('instala a raiz e pacotes com lock isolado, ignorando checkouts wt-*', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-v3-env-'))
    roots.push(root)
    await writePackage(root, 'root')
    await writePackage(resolve(root, 'projects/gerenteagentes/motor-v3'), 'motor-v3')
    await writePackage(resolve(root, 'wt-antigo/projeto'), 'ignorado')
    const install = vi.fn<(directory: string) => Promise<void>>().mockResolvedValue(undefined)
    const preparer = new WorkspaceEnvironmentPreparer(install)

    const prepared = await preparer.prepare(root)

    expect(prepared).toEqual([
      '.',
      'projects/gerenteagentes/motor-v3',
    ])
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('tenta limpar workspace antes de instalar (git checkout em package.json/lock)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-v3-env-clean-'))
    roots.push(root)
    await writePackage(root, 'root')
    const install = vi.fn<(directory: string) => Promise<void>>().mockResolvedValue(undefined)
    const preparer = new WorkspaceEnvironmentPreparer(install)

    // O prepare() deve tentar git status e git checkout antes de install
    // Em um diretório não-git, o ensureCleanWorkspace falha silenciosamente
    // e o install continua normalmente
    const prepared = await preparer.prepare(root)

    expect(prepared).toEqual(['.'])
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith(root)
  })

  it('serializa instalações concorrentes do mesmo worktree entre preparadores', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-v3-env-lock-'))
    roots.push(root)
    await writePackage(root, 'root')
    let active = 0
    let maximumActive = 0
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolveStarted => { releaseFirst = resolveStarted })
    let continueFirst!: () => void
    const firstCanFinish = new Promise<void>(resolveFinish => { continueFirst = resolveFinish })
    const install = vi.fn(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      if (install.mock.calls.length === 1) {
        releaseFirst()
        await firstCanFinish
      }
      active--
    })
    const first = new WorkspaceEnvironmentPreparer(install).prepare(root)
    await firstStarted
    const second = new WorkspaceEnvironmentPreparer(install).prepare(root)
    await new Promise(resolveWait => setTimeout(resolveWait, 20))

    expect(install).toHaveBeenCalledTimes(1)
    continueFirst()
    await Promise.all([first, second])
    expect(install).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(1)
  })

  it('libera o lock quando a instalação falha', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-v3-env-unlock-'))
    roots.push(root)
    await writePackage(root, 'root')
    const failing = new WorkspaceEnvironmentPreparer(vi.fn().mockRejectedValueOnce(new Error('falha npm')))
    await expect(failing.prepare(root)).rejects.toThrow('falha npm')

    const install = vi.fn().mockResolvedValue(undefined)
    await expect(new WorkspaceEnvironmentPreparer(install).prepare(root)).resolves.toEqual(['.'])
    expect(install).toHaveBeenCalledOnce()
  })
})

async function writePackage(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name, private: true }))
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3 }))
}
