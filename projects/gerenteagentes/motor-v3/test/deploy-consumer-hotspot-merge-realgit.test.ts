import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

/**
 * Integração com GIT REAL da fusão determinística de hotspots aditivos no
 * composeBatch (tarefa motor-hotspot-merge-deterministico, subtarefa 2).
 *
 * Fixtures reproduzem os conflitos reais que atrasaram deploys 4-12h em
 * 18-19/11 e 27/10:
 * - app.module.ts (batch b02b998e, 18/11): dois módulos importados e
 *   registrados no mesmo âncora do array `imports` por membros distintos.
 * - registry.ts + packages/api-client/src/index.ts (task-p1-1036, 27/10):
 *   telas/clientes adicionados nos mesmos pontos de registro.
 *
 * Cobre os critérios: (a) flag ON → composição succeeds sem isolamento,
 * composto determinístico (2 execuções iguais) e auditoria gravada;
 * (b) flag OFF → membro isolado com o MESMO conteúdo de `conflicts` de hoje
 * e zero evento de auditoria; (c) conflito não-aditivo em hotspot → fallback;
 * (d) conflito fora de hotspot → fallback.
 */

const APP_MODULE = 'apps/api/src/app.module.ts'
const REGISTRY = 'projects/biblioteca-global/screens/registry.ts'
const API_CLIENT = 'packages/api-client/src/index.ts'
const OUT_OF_HOTSPOT = 'src/fora-do-hotspot.ts'

const BASE_APP_MODULE = [
  "import { Module } from '@nestjs/common'",
  "import { CoreModule } from './core/core.module'",
  '',
  '@Module({',
  '  imports: [',
  '    CoreModule,',
  '  ],',
  '})',
  'export class AppModule {}',
  '',
].join('\n')

const BASE_REGISTRY = [
  "import { homeScreen } from './screens/home'",
  '',
  'export const screens = [',
  '  homeScreen,',
  ']',
  '',
].join('\n')

const BASE_API_CLIENT = [
  "export { createClient } from './client'",
  '',
  'export const resources = [',
  '  \"usuarios\",',
  ']',
  '',
].join('\n')

/**
 * Versão do hotspot para UM membro: insere o import e a entrada do próprio
 * módulo no mesmo âncora da base. Membros diferentes inserem linhas
 * DIFERENTES no mesmo ponto — é isso que produz o conflito real (adições
 * idênticas dos dois lados são mescladas limpas pelo git e NÃO conflitam).
 */
function memberAppModule(importLine: string, moduleName: string): string {
  return [
    "import { Module } from '@nestjs/common'",
    "import { CoreModule } from './core/core.module'",
    importLine,
    '',
    '@Module({',
    '  imports: [',
    '    CoreModule,',
    `    ${moduleName},`,
    '  ],',
    '})',
    'export class AppModule {}',
    '',
  ].join('\n')
}

function memberRegistry(importLine: string, entry: string): string {
  return [
    "import { homeScreen } from './screens/home'",
    importLine,
    '',
    'export const screens = [',
    '  homeScreen,',
    `  ${entry},`,
    ']',
    '',
  ].join('\n')
}

function memberApiClient(exportLine: string, entry: string): string {
  return [
    "export { createClient } from './client'",
    exportLine,
    '',
    'export const resources = [',
    '  \"usuarios\",',
    `  ${entry},`,
    ']',
    '',
  ].join('\n')
}

/** Conflito NÃO-aditivo no mesmo hotspot: membro A também edita a linha existente `CoreModule,`. */
function memberAppModuleNonAdditive(importLine: string, moduleName: string): string {
  return [
    "import { Module } from '@nestjs/common'",
    "import { CoreModule } from './core/core.module'",
    importLine,
    '',
    '@Module({',
    '  imports: [',
    '    CoreModule, // renomeado pelo membro A',
    `    ${moduleName},`,
    '  ],',
    '})',
    'export class AppModule {}',
    '',
  ].join('\n')
}

let tempDirs: string[] = []

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

interface FixtureOptions {
  conflictFiles: string[]
  appModuleMemberA?: string
  appModuleMemberB?: string
  registryMemberA?: string
  registryMemberB?: string
  apiClientMemberA?: string
  apiClientMemberB?: string
  genericMemberA?: string
  genericMemberB?: string
}

/**
 * Repositório real: base com os arquivos-hotspot na versão BASE; dois commits
 * de membro (A e B) derivando do MESMO merge-base e tocando os mesmos pontos
 * de registro. `requestedCommitA/B` são tips que o composeBatch enumerará via
 * `git cherry`; o compose roda em worktree destacado no tip da base.
 */
async function buildFixture(options: FixtureOptions): Promise<{ repo: string; requestedCommitA: string; requestedCommitB: string }> {
  const repo = await makeTempDir('motor-hotspot-repo-')
  git(['init', '-b', 'base-desenvolvimento', repo], repo)
  git(['config', 'user.email', 'motor@test.local'], repo)
  git(['config', 'user.name', 'Motor Test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)

  const write = async (relPath: string, content: string) => {
    const abs = join(repo, relPath)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }

  if (options.conflictFiles.includes(APP_MODULE)) await write(APP_MODULE, BASE_APP_MODULE)
  if (options.conflictFiles.includes(REGISTRY)) await write(REGISTRY, BASE_REGISTRY)
  if (options.conflictFiles.includes(API_CLIENT)) await write(API_CLIENT, BASE_API_CLIENT)
  if (options.conflictFiles.includes(OUT_OF_HOTSPOT)) await write(OUT_OF_HOTSPOT, 'export const shared = [\n  1,\n]\n')
  await write('README.md', '# fixture\n')
  // O composeBatch roda `npm ci` no worktree composto (fix 4f498571/5b5cc3ed).
  // A fixture precisa de package.json + package-lock.json (sem dependências,
  // instala offline) e de .gitignore para o node_modules não sujar o
  // `git status --porcelain` verificado nos testes.
  await write('package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2)}\n`)
  await write('package-lock.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0' } },
  }, null, 2)}\n`)
  await write('.gitignore', 'node_modules/\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'merge-base'], repo)
  const mergeBase = git(['rev-parse', 'HEAD'], repo).trim()

  // Membro A: deriva da base e adiciona nos pontos de registro.
  git(['checkout', '-b', 'member-a', mergeBase], repo)
  if (options.appModuleMemberA) await write(APP_MODULE, options.appModuleMemberA)
  if (options.registryMemberA) await write(REGISTRY, options.registryMemberA)
  if (options.apiClientMemberA) await write(API_CLIENT, options.apiClientMemberA)
  if (options.genericMemberA) await write(OUT_OF_HOTSPOT, options.genericMemberA)
  await write('member-a.ts', 'export const a = 1\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'membro A: registra suas entradas'], repo)
  const memberASha = git(['rev-parse', 'HEAD'], repo).trim()

  // Membro B: deriva da base e adiciona entradas PRÓPRIAS (diferentes das de A)
  // nos MESMOS pontos de registro — é a colisão aditiva real que o merge
  // determinístico resolve.
  git(['checkout', '-b', 'member-b', mergeBase], repo)
  if (options.appModuleMemberB) await write(APP_MODULE, options.appModuleMemberB)
  if (options.registryMemberB) await write(REGISTRY, options.registryMemberB)
  if (options.apiClientMemberB) await write(API_CLIENT, options.apiClientMemberB)
  if (options.genericMemberB) await write(OUT_OF_HOTSPOT, options.genericMemberB)
  await write('member-b.ts', 'export const b = 2\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'membro B: registra suas entradas'], repo)
  const memberBSha = git(['rev-parse', 'HEAD'], repo).trim()

  git(['checkout', 'base-desenvolvimento'], repo)
  // A base avança um commit não relacionado (o batch compõe SOBRE a base, não no merge-base).
  await write('base-note.ts', 'export const base = true\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'base: commit posterior ao merge-base'], repo)

  return { repo, requestedCommitA: memberASha, requestedCommitB: memberBSha }
}

function repositoryMock(flagOn: boolean, hotspots: string[]) {
  return {
    isDeterministicHotspotMergeEnabled: vi.fn(async () => flagOn),
    additiveHotspotPaths: vi.fn(async () => hotspots),
  }
}

function taskEventsMock() {
  const events: Array<{ taskId: string; event: string; actor?: string; payload: Record<string, unknown> | null }> = []
  return { events, sink: { record: async (taskId: string, event: string, actor?: string, payload: Record<string, unknown> | null = null) => { events.push({ taskId, event, actor, payload }) } } }
}

async function composeWith(consumer: DeployConsumer, repo: string, batchId: string, shaA: string, shaB: string) {
  return (consumer as any).composeBatch(
    repo,
    'base-desenvolvimento',
    batchId,
    [
      { requestedCommit: shaA, taskId: 'task-a', databaseTaskId: 11, index: 0 },
      { requestedCommit: shaB, taskId: 'task-b', databaseTaskId: 12, index: 1 },
    ],
  ) as Promise<{ path: string; commit: string; conflicts: Array<Record<string, unknown>> }>
}

const SEED_HOTSPOTS = [APP_MODULE, REGISTRY, API_CLIENT, 'apps/web/src/project/registry/__tests__/customScreens.test.tsx']

describe('DeployConsumer.composeBatch — fusão determinística de hotspots aditivos (git real)', () => {
  it('fixture produz o conflito real esperado (sanidade: ambos os picks colidem no mesmo arquivo)', async () => {
    const { repo, requestedCommitA, requestedCommitB } = await buildFixture({
      conflictFiles: [APP_MODULE],
      appModuleMemberA: memberAppModule("import { AuthModule } from './auth/auth.module'", 'AuthModule'),
      appModuleMemberB: memberAppModule("import { BillingModule } from './billing/billing.module'", 'BillingModule'),
    })
    // Sanidade do fixture: cherry-pick manual de A sobre a base aplica limpo e o de B
    // conflita SOMENTE no hotspot (padrão confirmado na investigação de 27/10).
    const wt = await makeTempDir('motor-hotspot-sanity-')
    await rm(wt, { recursive: true, force: true })
    git(['worktree', 'add', '--detach', wt, 'base-desenvolvimento'], repo)
    git(['cherry-pick', requestedCommitA], wt)
    expect(() => git(['cherry-pick', requestedCommitB], wt)).toThrow()
    expect(git(['diff', '--name-only', '--diff-filter=U'], wt).trim()).toBe(APP_MODULE)
    git(['cherry-pick', '--abort'], wt)
  }, 30_000)

  it('flag ON: conflito puramente aditivo em hotspots → composição succeeds sem isolamento e com auditoria', async () => {
    const { repo, requestedCommitA, requestedCommitB } = await buildFixture({
      conflictFiles: [APP_MODULE, REGISTRY, API_CLIENT],
      appModuleMemberA: memberAppModule("import { AuthModule } from './auth/auth.module'", 'AuthModule'),
      appModuleMemberB: memberAppModule("import { BillingModule } from './billing/billing.module'", 'BillingModule'),
      registryMemberA: memberRegistry("import { cadastroScreen } from './screens/cadastro'", 'cadastroScreen'),
      registryMemberB: memberRegistry("import { financeiroScreen } from './screens/financeiro'", 'financeiroScreen'),
      apiClientMemberA: memberApiClient("export { authClient } from './auth'", '\"auth-recurso\"'),
      apiClientMemberB: memberApiClient("export { billingClient } from './billing'", '\"billing-recurso\"'),
    })
    const { events, sink } = taskEventsMock()
    const consumer = new DeployConsumer(repositoryMock(true, SEED_HOTSPOTS) as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const result = await composeWith(consumer, repo, 'batch-hotspot-on', requestedCommitA, requestedCommitB)

      // Composição seguiu sem isolar membros: zero conflitos reportados.
      expect(result.conflicts).toEqual([])

      // O composto contém as entradas dos DOIS membros nos três hotspots, em
      // ordem determinística (lexicográfica UTF-16 por linha de inserção).
      const { readFileSync } = await import('node:fs')
      const composedAppModule = readFileSync(join(result.path, APP_MODULE), 'utf8')
      expect(composedAppModule).toContain("import { AuthModule } from './auth/auth.module'")
      expect(composedAppModule).toContain("import { BillingModule } from './billing/billing.module'")
      expect(composedAppModule).toContain('AuthModule,')
      expect(composedAppModule).toContain('BillingModule,')
      expect(composedAppModule).toContain('CoreModule,')
      const composedRegistry = readFileSync(join(result.path, REGISTRY), 'utf8')
      expect(composedRegistry).toContain("import { cadastroScreen } from './screens/cadastro'")
      expect(composedRegistry).toContain("import { financeiroScreen } from './screens/financeiro'")
      const composedApiClient = readFileSync(join(result.path, API_CLIENT), 'utf8')
      expect(composedApiClient).toContain("export { authClient } from './auth'")
      expect(composedApiClient).toContain("export { billingClient } from './billing'")

      // Nenhum estado de cherry-pick pendurado; worktree limpo no HEAD composto.
      expect(git(['status', '--porcelain'], result.path).trim()).toBe('')
      expect(() => git(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], result.path)).toThrow()

      // Auditoria: log estruturado no console + evento de tarefa via TaskEventSink.
      const consoleEvent = logSpy.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('"hotspot_merged_deterministic"'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(consoleEvent.length).toBeGreaterThanOrEqual(1)
      expect(consoleEvent[0]).toMatchObject({ event: 'hotspot_merged_deterministic', batchId: 'batch-hotspot-on' })
      expect(consoleEvent.some(entry => Array.isArray(entry.files) && (entry.files as string[]).includes(APP_MODULE))).toBe(true)

      const audit = events.filter(event => event.event === 'hotspot_merged_deterministic')
      expect(audit.length).toBeGreaterThanOrEqual(1)
      expect(audit.every(event => ['task-a', 'task-b'].includes(event.taskId))).toBe(true)
      expect(audit.every(event => event.actor === 'motor')).toBe(true)
      expect(audit.some(event => Array.isArray(event.payload?.files) && (event.payload!.files as string[]).includes(REGISTRY))).toBe(true)
      expect(audit.some(event => Array.isArray(event.payload?.members))).toBe(true)

      // Limpeza do worktree de composição criado pelo composeBatch.
      await rm(result.path, { recursive: true, force: true }).catch(() => undefined)
      git(['worktree', 'prune'], repo)
    } finally {
      logSpy.mockRestore()
    }
  }, 60_000)

  it('flag ON: duas execuções independentes produzem o MESMO composto (determinismo)', async () => {
    const build = () => buildFixture({
      conflictFiles: [APP_MODULE],
      appModuleMemberA: memberAppModule("import { AuthModule } from './auth/auth.module'", 'AuthModule'),
      appModuleMemberB: memberAppModule("import { BillingModule } from './billing/billing.module'", 'BillingModule'),
    })
    const composeOnce = async (batchId: string) => {
      const { repo, requestedCommitA, requestedCommitB } = await build()
      const consumer = new DeployConsumer(repositoryMock(true, SEED_HOTSPOTS) as never, {} as never, {} as never)
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      try {
        const result = await composeWith(consumer, repo, batchId, requestedCommitA, requestedCommitB)
        const { readFileSync } = await import('node:fs')
        const content = readFileSync(join(result.path, APP_MODULE), 'utf8')
        await rm(result.path, { recursive: true, force: true }).catch(() => undefined)
        git(['worktree', 'prune'], repo)
        return { result, content }
      } finally {
        logSpy.mockRestore()
      }
    }
    const first = await composeOnce('batch-det-1')
    const second = await composeOnce('batch-det-2')
    expect(first.result.conflicts).toEqual([])
    expect(second.result.conflicts).toEqual([])
    expect(first.content).toBe(second.content)
  }, 60_000)

  it('flag OFF (padrão): paridade exata — membro isolado com o mesmo conteúdo de conflicts de hoje e zero auditoria', async () => {
    const { repo, requestedCommitA, requestedCommitB } = await buildFixture({
      conflictFiles: [APP_MODULE],
      appModuleMemberA: memberAppModule("import { AuthModule } from './auth/auth.module'", 'AuthModule'),
      appModuleMemberB: memberAppModule("import { BillingModule } from './billing/billing.module'", 'BillingModule'),
    })
    const { events, sink } = taskEventsMock()
    const consumer = new DeployConsumer(repositoryMock(false, SEED_HOTSPOTS) as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink)
    const result = await composeWith(consumer, repo, 'batch-hotspot-off', requestedCommitA, requestedCommitB)

    // Comportamento vigente: exatamente um membro isolado (o segundo a conflitar).
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.taskId).toBe('task-b')
    expect(result.conflicts[0]!.index).toBe(1)
    expect(result.conflicts[0]!.conflictFiles).toEqual([APP_MODULE])
    // Paridade com o comportamento real de hoje: o excerpt vem do error.message
    // do execFile (stderr do git); a linha "CONFLICT (content)" vai para o
    // STDOUT do cherry-pick e não compõe o excerpt.
    expect(result.conflicts[0]!.conflictExcerpt).toContain('could not apply')
    // O primeiro membro seguiu: o HEAD composto contém o commit de A e NÃO o
    // de B (o isolado continua derivando do merge-base original — merge-base
    // entre HEAD e taskCommit jamais seria o próprio HEAD).
    const composedLog = git(['log', '--format=%s'], result.path)
    expect(composedLog).toContain('membro A: registra suas entradas')
    expect(composedLog).not.toContain('membro B: registra suas entradas')
    expect(git(['merge-base', 'HEAD', String(result.conflicts[0]!.taskCommit)], result.path).trim())
      .not.toBe(git(['rev-parse', 'HEAD'], result.path).trim())
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(result.path, APP_MODULE), 'utf8')).toContain("import { AuthModule } from './auth/auth.module'")
    // Nenhum evento de auditoria de fusão com a flag desligada.
    expect(events.filter(event => event.event === 'hotspot_merged_deterministic')).toEqual([])

    await rm(result.path, { recursive: true, force: true }).catch(() => undefined)
    git(['worktree', 'prune'], repo)
  }, 60_000)

  it('conflito NÃO-aditivo em hotspot → fallback exato (membro isolado, sem fusão)', async () => {
    const { repo, requestedCommitA, requestedCommitB } = await buildFixture({
      conflictFiles: [APP_MODULE],
      // A edição de `CoreModule,` (linha existente) torna o lado A não-aditivo.
      appModuleMemberA: memberAppModuleNonAdditive("import { AuthModule } from './auth/auth.module'", 'AuthModule'),
      appModuleMemberB: memberAppModule("import { BillingModule } from './billing/billing.module'", 'BillingModule'),
    })
    const consumer = new DeployConsumer(repositoryMock(true, SEED_HOTSPOTS) as never, {} as never, {} as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const result = await composeWith(consumer, repo, 'batch-hotspot-nonadditive', requestedCommitA, requestedCommitB)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.taskId).toBe('task-b')
      expect(result.conflicts[0]!.conflictFiles).toEqual([APP_MODULE])
      const logged = logSpy.mock.calls.map(call => String(call[0])).filter(line => line.includes('"hotspot_merged_deterministic"'))
      expect(logged).toEqual([])
      await rm(result.path, { recursive: true, force: true }).catch(() => undefined)
      git(['worktree', 'prune'], repo)
    } finally {
      logSpy.mockRestore()
    }
  }, 60_000)

  it('conflito fora da lista de hotspots → isolamento inalterado mesmo com flag ON', async () => {
    const { repo, requestedCommitA, requestedCommitB } = await buildFixture({
      conflictFiles: [OUT_OF_HOTSPOT],
      genericMemberA: 'export const shared = [\n  1,\n  2, // membro A\n]\n',
      genericMemberB: 'export const shared = [\n  1,\n  3, // membro B\n]\n',
    })
    const consumer = new DeployConsumer(repositoryMock(true, SEED_HOTSPOTS) as never, {} as never, {} as never)
    const result = await composeWith(consumer, repo, 'batch-hotspot-outside', requestedCommitA, requestedCommitB)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.taskId).toBe('task-b')
    expect(result.conflicts[0]!.conflictFiles).toEqual([OUT_OF_HOTSPOT])
    await rm(result.path, { recursive: true, force: true }).catch(() => undefined)
    git(['worktree', 'prune'], repo)
  }, 60_000)
})
