// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContractArtifactStore } from '../src/analysis/ContractArtifactStore.js'

describe('ContractArtifactStore', () => {
  const roots: string[] = []
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

  it('materializa contrato versionado com hash verificável fora do repositório', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'motor-contract-'))
    roots.push(root)
    const artifact = await new ContractArtifactStore(root).materialize({
      agentId: 'agente-teste', promptKey: 'analista.primeira_rodada_tarefa', contractVersionId: 9,
      instructions: 'Responda somente JSON.', schema: { type: 'object' }, example: { ok: true },
    })
    const content = await readFile(artifact.path, 'utf8')

    expect(artifact.path).toContain('/agente-teste/.motor/contracts/analista.primeira_rodada_tarefa/v9-')
    expect(createHash('sha256').update(content).digest('hex')).toBe(artifact.sha256)
    expect(JSON.parse(content)).toMatchObject({ contractVersion: 9, schema: { type: 'object' } })
  })

  it('rejeita segmentos que escapariam do workspace', async () => {
    await expect(new ContractArtifactStore('/tmp').materialize({
      agentId: '../fora', promptKey: 'analista', contractVersionId: 1,
      instructions: '', schema: {}, example: {},
    })).rejects.toThrow('agentId inválido')
  })
})
