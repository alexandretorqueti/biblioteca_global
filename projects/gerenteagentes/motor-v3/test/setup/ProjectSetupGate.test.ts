import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  REQUIRED_SETUP_ARTIFACTS,
  resolveSetupProjectDir,
  validateProjectSetupArtifacts,
  validateProjectSetupEvidence,
  validateSetupCompletion,
  type FsLike,
} from '../../src/setup/ProjectSetupGate.js'

const valid = {
  checklist: { structure: true, configSchemaMigrations: true, registries: true, repoPath: true },
  smoke_test: { url: 'http://localhost:3000/api/demo/', method: 'GET', status: 200, response_body: '{}', timestamp: '2026-10-20T00:00:00.000Z' },
}

describe('ProjectSetupGate', () => {
  it('accepts checklist complete with HTTP 2xx JSON evidence', () => {
    expect(validateProjectSetupEvidence(valid).ok).toBe(true)
  })

  it('rejects incomplete checklist', () => {
    const result = validateProjectSetupEvidence({ ...valid, checklist: { ...valid.checklist, registries: false } })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reasons).toContain('checklist incompleto: registries')
  })

  it('rejects missing or non-2xx smoke evidence', () => {
    expect(validateProjectSetupEvidence({ ...valid, smoke_test: undefined }).ok).toBe(false)
    expect(validateProjectSetupEvidence({ ...valid, smoke_test: { ...valid.smoke_test, status: 500 } }).ok).toBe(false)
  })

  it('requires agentLink when the checklist declares it applicable', () => {
    const result = validateProjectSetupEvidence({ ...valid, checklist: { ...valid.checklist, agentLink: false } })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reasons).toContain('checklist incompleto: agentLink')
  })

  it('aceita checklist standalone de inspeção, contexto e commit/push', () => {
    const result = validateProjectSetupEvidence({
      checklist: { repoInspected: true, analystContext: true, commitPush: true },
      smoke_test: valid.smoke_test,
    }, 'standalone')
    expect(result.ok).toBe(true)
  })

  it('não aplica checklist monorepo a projeto standalone', () => {
    const result = validateProjectSetupEvidence(valid, 'standalone')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons).toContain('checklist incompleto: repoInspected')
  })
})

describe('resolveSetupProjectDir', () => {
  it('resolve a raiz do repo para projeto standalone', async () => {
    const repo = await makeTempDir()
    await expect(resolveSetupProjectDir(repo, 'consoleopenclaw', 'standalone')).resolves.toBe(resolve(repo))
  })

  it('mantém o diretório projects/<slug> para projeto monorepo', async () => {
    const repo = await makeTempDir()
    await expect(resolveSetupProjectDir(repo, 'consoleopenclaw', 'monorepo')).resolves.toBe(join(resolve(repo), 'projects', 'consoleopenclaw'))
  })
})

// task-p2-1072: gate de artefatos em disco — docs/CONTEXTO-ANALISTA.md é o
// mesmo artefato exigido pelo preflight do ConsoleAnalystRunner.
const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'setup-gate-'))
  tempDirs.push(dir)
  return dir
}

function fakeFs(existing: Set<string>): FsLike {
  return {
    access: async (path) => {
      if (!existing.has(resolve(path))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    stat: async (path) => {
      const resolved = resolve(path)
      const isDir = [...existing].some(file => file.startsWith(resolved + '/')) || existing.has(resolved + '/')
      if (!isDir && !existing.has(resolved)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isDirectory: () => isDir }
    },
  }
}

describe('validateProjectSetupArtifacts', () => {
  it('returns ok=true when docs/CONTEXTO-ANALISTA.md exists (real tmp dir)', async () => {
    const projectDir = await makeTempDir()
    await mkdir(join(projectDir, 'docs'), { recursive: true })
    await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto\n')
    await expect(validateProjectSetupArtifacts(projectDir)).resolves.toEqual({ ok: true })
  })

  it('returns ok=false with explicit reason when the artifact is missing (real tmp dir)', async () => {
    const projectDir = await makeTempDir()
    const result = await validateProjectSetupArtifacts(projectDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    }
  })

  it('reports missing project dir explicitly', async () => {
    const result = await validateProjectSetupArtifacts('/caminho/inexistente/setup-gate-test')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.some(reason => reason.includes('inexistente ou inacessível'))).toBe(true)
      expect(result.reasons).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    }
  })

  it('rejects empty project dir', async () => {
    const result = await validateProjectSetupArtifacts('')
    expect(result.ok).toBe(false)
  })

  it('works with injected fake fs', async () => {
    const projectDir = '/repo/projects/demo'
    const artifact = resolve(projectDir, ...REQUIRED_SETUP_ARTIFACTS[0].split('/'))
    const withArtifact = fakeFs(new Set([resolve(projectDir) + '/', artifact]))
    await expect(validateProjectSetupArtifacts(projectDir, withArtifact)).resolves.toEqual({ ok: true })
    const withoutArtifact = fakeFs(new Set([resolve(projectDir) + '/']))
    const result = await validateProjectSetupArtifacts(projectDir, withoutArtifact)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
  })
})

describe('validateSetupCompletion', () => {
  it('passes only when evidence AND artifacts pass', async () => {
    const projectDir = await makeTempDir()
    await mkdir(join(projectDir, 'docs'), { recursive: true })
    await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto\n')
    const result = await validateSetupCompletion({ evidence: valid, projectDir })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.evidence).toEqual(valid)
  })

  it('aggregates evidence and artifact reasons when both fail', async () => {
    const projectDir = await makeTempDir()
    const result = await validateSetupCompletion({
      evidence: { ...valid, checklist: { ...valid.checklist, registries: false } },
      projectDir,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons).toContain('checklist incompleto: registries')
      expect(result.reasons).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
    }
  })

  it('fails on missing artifact even with perfect evidence', async () => {
    const projectDir = await makeTempDir()
    const result = await validateSetupCompletion({ evidence: valid, projectDir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons).toContain('artefato obrigatório ausente: docs/CONTEXTO-ANALISTA.md')
  })

  it('fails on invalid evidence even with all artifacts present', async () => {
    const projectDir = await makeTempDir()
    await mkdir(join(projectDir, 'docs'), { recursive: true })
    await writeFile(join(projectDir, 'docs', 'CONTEXTO-ANALISTA.md'), '# Contexto\n')
    const result = await validateSetupCompletion({ evidence: null, projectDir })
    expect(result).toEqual({ ok: false, reasons: ['evidência de setup ausente'] })
  })
})
