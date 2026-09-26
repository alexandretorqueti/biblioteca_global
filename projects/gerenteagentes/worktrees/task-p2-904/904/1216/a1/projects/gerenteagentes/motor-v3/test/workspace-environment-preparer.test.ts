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

  it('instala pacotes com lock isolado e ignora a raiz e checkouts wt-*', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-v3-env-'))
    roots.push(root)
    await writePackage(root, 'root')
    await writePackage(resolve(root, 'projects/gerenteagentes/motor-v2'), 'motor-v2')
    await writePackage(resolve(root, 'projects/gerenteagentes/motor-v3'), 'motor-v3')
    await writePackage(resolve(root, 'wt-antigo/projeto'), 'ignorado')
    const install = vi.fn<(directory: string) => Promise<void>>().mockResolvedValue(undefined)
    const preparer = new WorkspaceEnvironmentPreparer(install)

    const prepared = await preparer.prepare(root)

    expect(prepared).toEqual([
      'projects/gerenteagentes/motor-v2',
      'projects/gerenteagentes/motor-v3',
    ])
    expect(install).toHaveBeenCalledTimes(2)
  })
})

async function writePackage(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name, private: true }))
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3 }))
}
