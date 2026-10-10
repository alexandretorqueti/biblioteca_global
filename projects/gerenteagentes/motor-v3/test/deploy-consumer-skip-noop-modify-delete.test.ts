import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Regressão: skipNoopCherryPickConflict tolerante a modify/delete (tarefa 980).
 *
 * Cenário real (deploy-b82203e7): `git checkout --ours -- .` crasha quando
 * existe conflito modify/delete em que "ours" não tem o arquivo (ex.: outro
 * membro do batch já deletou o arquivo). A exceção propagava e derrubava o
 * batch inteiro. A correção processa cada caminho individualmente: tenta
 * checkout --ours e, se falhar, usa git rm para preservar a remoção.
 */

const calls: Array<{ command: string; args: string[] }> = []
let unmergedPaths: string[] = []
let checkoutOursFailPaths: Set<string> = new Set()
let gitRmFailPaths: Set<string> = new Set()
let cachedDiffQuietResult: 'clean' | 'dirty' = 'clean'
let diffFilterUFails = false
let checkoutOursAllFails = false
let unexpectedError: Error | null = null
let allCommandsFail = false // para simular falha catastrófica em todos os comandos
let cherryPickFailCommits: Set<string> = new Set()

function cherryForCommit(inputCommit: string): string {
  return `cc${inputCommit.slice(0, 6)}${'c'.repeat(32)}`.slice(0, 40)
}

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args: [...args] })

    // --- composeBatch handlers ---
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return callback(null, { stdout: '/repo\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return callback(null, { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'worktree') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return callback(new Error('not ancestor'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry') {
      const inputCommit = args[2] as string
      const cherryCommit = `cc${inputCommit.slice(0, 6)}${'c'.repeat(32)}`.slice(0, 40)
      return callback(null, { stdout: `+ ${cherryCommit}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--abort') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--skip') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args.length === 2 && args[1] !== '--abort' && args[1] !== '--skip') {
      const commit = args[1]!
      if (cherryPickFailCommits.has(commit)) {
        return callback(new Error(`CONFLICT (content): Merge conflict in ${unmergedPaths.join(', ') || 'src/conflict.ts'}`), { stdout: '', stderr: '' })
      }
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'npm') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'test') {
      return callback(new Error('not found'), { stdout: '', stderr: '' })
    }

    // --- skipNoopCherryPickConflict handlers ---

    // git diff --name-only --diff-filter=U → lista caminhos unmerged
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      if (diffFilterUFails) return callback(new Error('unexpected diff failure'), { stdout: '', stderr: '' })
      return callback(null, { stdout: unmergedPaths.join('\n') + '\n', stderr: '' })
    }

    // git checkout --ours -- <path> (individual) ou -- . (legado)
    if (command === 'git' && args[0] === 'checkout' && args[1] === '--ours') {
      if (allCommandsFail) return callback(new Error('catastrophic checkout failure'), { stdout: '', stderr: '' })
      if (unexpectedError) return callback(unexpectedError, { stdout: '', stderr: '' })
      if (checkoutOursAllFails) return callback(new Error('checkout --ours failed'), { stdout: '', stderr: '' })
      // Falha seletiva por caminho
      const targetPath = args[args.length - 1]
      if (targetPath && checkoutOursFailPaths.has(targetPath)) {
        return callback(new Error(`error: path ${targetPath} does not have our version`), { stdout: '', stderr: '' })
      }
      return callback(null, { stdout: '', stderr: '' })
    }

    // git rm -- <path>
    if (command === 'git' && args[0] === 'rm') {
      if (allCommandsFail) return callback(new Error('catastrophic rm failure'), { stdout: '', stderr: '' })
      const targetPath = args[args.length - 1]
      if (targetPath && gitRmFailPaths.has(targetPath)) {
        return callback(new Error(`git rm failed for ${targetPath}`), { stdout: '', stderr: '' })
      }
      return callback(null, { stdout: '', stderr: '' })
    }

    // git add --update -- .
    if (command === 'git' && args[0] === 'add' && args[1] === '--update') {
      if (allCommandsFail) return callback(new Error('catastrophic add failure'), { stdout: '', stderr: '' })
      return callback(null, { stdout: '', stderr: '' })
    }

    // git diff --cached --quiet HEAD → clean=noop, dirty=conflito real
    if (command === 'git' && args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      if (cachedDiffQuietResult === 'clean') return callback(null, { stdout: '', stderr: '' })
      return callback(new Error('has changes'), { stdout: '', stderr: '' })
    }

    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('skipNoopCherryPickConflict — modify/delete tolerance (tarefa 980)', () => {
  beforeEach(() => {
    calls.length = 0
    unmergedPaths = []
    checkoutOursFailPaths = new Set()
    gitRmFailPaths = new Set()
    cachedDiffQuietResult = 'clean'
    diffFilterUFails = false
    checkoutOursAllFails = false
    unexpectedError = null
    allCommandsFail = false
    cherryPickFailCommits = new Set()
  })

  it('conflito modify/delete: arquivo ausente em ours → git rm preserva remoção, retorna true (noop)', async () => {
    // Cenário: TaskMonitorScreen.tsx foi deletado por outro membro do batch,
    // mas um commit posterior modifica o mesmo arquivo. checkout --ours falha
    // porque "ours" não tem o arquivo; git rm deve ser usado.
    unmergedPaths = [
      'projects/gerenteagentes/screens/TaskMonitorScreen.tsx',
      'projects/gerenteagentes/screens/TaskMonitorScreen.test.tsx',
    ]
    checkoutOursFailPaths.add('projects/gerenteagentes/screens/TaskMonitorScreen.tsx')
    checkoutOursFailPaths.add('projects/gerenteagentes/screens/TaskMonitorScreen.test.tsx')
    cachedDiffQuietResult = 'clean' // noop: após resolver, staged == HEAD

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(true)

    // checkout --ours foi tentado para cada caminho
    const checkoutCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'checkout' && c.args[1] === '--ours')
    expect(checkoutCalls).toHaveLength(2)
    expect(checkoutCalls[0]!.args).toContain('projects/gerenteagentes/screens/TaskMonitorScreen.tsx')
    expect(checkoutCalls[1]!.args).toContain('projects/gerenteagentes/screens/TaskMonitorScreen.test.tsx')

    // git rm foi chamado para cada caminho que falhou no checkout
    const rmCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'rm')
    expect(rmCalls).toHaveLength(2)
    expect(rmCalls[0]!.args).toContain('projects/gerenteagentes/screens/TaskMonitorScreen.tsx')
    expect(rmCalls[1]!.args).toContain('projects/gerenteagentes/screens/TaskMonitorScreen.test.tsx')

    // git add --update foi chamado após resolver todos os caminhos
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'add' && c.args[1] === '--update')).toBe(true)
  })

  it('conflito modify/delete com diff real → git rm + retorna false (conflito real)', async () => {
    unmergedPaths = ['src/deleted-file.ts']
    checkoutOursFailPaths.add('src/deleted-file.ts')
    cachedDiffQuietResult = 'dirty' // após resolver, staged != HEAD = conflito real

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)

    // git rm foi chamado (preservou a remoção)
    const rmCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'rm')
    expect(rmCalls).toHaveLength(1)
  })

  it('conflito noop simples (sem modify/delete) → checkout --ours funciona, retorna true', async () => {
    unmergedPaths = ['src/file.ts']
    cachedDiffQuietResult = 'clean'

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(true)

    // checkout --ours foi chamado individualmente (não mais -- .)
    const checkoutCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'checkout' && c.args[1] === '--ours')
    expect(checkoutCalls).toHaveLength(1)
    expect(checkoutCalls[0]!.args).toContain('src/file.ts')

    // git rm NÃO foi chamado
    const rmCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'rm')
    expect(rmCalls).toHaveLength(0)
  })

  it('conflito real (checkout funciona mas diff mostra mudanças) → retorna false', async () => {
    unmergedPaths = ['src/real-conflict.ts']
    cachedDiffQuietResult = 'dirty'

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)

    // checkout --ours funcionou (sem git rm)
    const checkoutCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'checkout' && c.args[1] === '--ours')
    expect(checkoutCalls).toHaveLength(1)
    const rmCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'rm')
    expect(rmCalls).toHaveLength(0)
  })

  it('sem caminhos unmerged → retorna false imediatamente', async () => {
    unmergedPaths = []

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)

    // Nenhum checkout, rm, ou add foi chamado
    expect(calls.filter(c => c.command === 'git' && c.args[0] === 'checkout')).toHaveLength(0)
    expect(calls.filter(c => c.command === 'git' && c.args[0] === 'rm')).toHaveLength(0)
    expect(calls.filter(c => c.command === 'git' && c.args[0] === 'add')).toHaveLength(0)
  })

  it('mistura: alguns caminhos checkout OK, outros modify/delete → resolve todos, retorna classificação correta', async () => {
    unmergedPaths = ['src/ok.ts', 'src/deleted.ts', 'src/also-ok.ts']
    checkoutOursFailPaths.add('src/deleted.ts')
    cachedDiffQuietResult = 'clean'

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(true)

    // 3 checkouts tentados
    const checkoutCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'checkout' && c.args[1] === '--ours')
    expect(checkoutCalls).toHaveLength(3)

    // Apenas 1 git rm (o caminho modify/delete)
    const rmCalls = calls.filter(c => c.command === 'git' && c.args[0] === 'rm')
    expect(rmCalls).toHaveLength(1)
    expect(rmCalls[0]!.args).toContain('src/deleted.ts')
  })

  it('falha inesperada na resolução → degrada para false (isolamento do membro), não propaga exceção', async () => {
    // Tanto checkout quanto rm e add falham → catch externo captura e retorna false
    unmergedPaths = ['src/file.ts']
    allCommandsFail = true

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    // NÃO deve lançar — deve retornar false
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)
  })

  it('falha no git diff --diff-filter=U → degrada para false, não propaga exceção', async () => {
    diffFilterUFails = true

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)
  })

  it('falha no git rm (modify/delete irrecuperável) → degrada para false', async () => {
    unmergedPaths = ['src/broken.ts']
    checkoutOursFailPaths.add('src/broken.ts')
    gitRmFailPaths.add('src/broken.ts')

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).skipNoopCherryPickConflict('/worktree')

    expect(result).toBe(false)
  })
})

/**
 * Os testes de composeBatch usam o MESMO mock acima, mas precisam que os
 * handlers de git rev-parse, merge-base, cherry, cherry-pick, worktree e npm
 * estejam cobertos pelo mock genérico. O mock é reconfigurado via beforeEach.
 */
describe('composeBatch — integração com skipNoopCherryPickConflict modify/delete', () => {
  beforeEach(() => {
    calls.length = 0
    cherryPickFailCommits = new Set()
    unmergedPaths = []
    checkoutOursFailPaths = new Set()
    gitRmFailPaths = new Set()
    cachedDiffQuietResult = 'clean'
    diffFilterUFails = false
    checkoutOursAllFails = false
    unexpectedError = null
    allCommandsFail = false
  })

  it('conflito modify/delete noop → membro NÃO é isolado, batch segue normalmente', async () => {
    const member2Cherry = cherryForCommit('b'.repeat(40))
    cherryPickFailCommits.add(member2Cherry)
    // skipNoop retorna true: é noop (modify/delete resolvido com git rm)
    unmergedPaths = ['projects/gerenteagentes/screens/TaskMonitorScreen.tsx']
    checkoutOursFailPaths.add('projects/gerenteagentes/screens/TaskMonitorScreen.tsx')
    cachedDiffQuietResult = 'clean'

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-modify-delete-noop', [
      { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
      { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
      { requestedCommit: 'd'.repeat(40), taskId: 'task-3', databaseTaskId: 3, index: 2 },
    ])

    // Zero conflitos reais (modify/delete foi noop)
    expect(result.conflicts).toHaveLength(0)

    // cherry-pick --skip foi chamado para o noop
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--skip')).toBe(true)

    // cherry-pick --abort NÃO foi chamado
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(false)
  })

  it('falha inesperada no skipNoop → degrada para isolamento do membro, batch segue com compatíveis', async () => {
    const member2Cherry = cherryForCommit('b'.repeat(40))
    cherryPickFailCommits.add(member2Cherry)
    // skipNoop degrada para false (todos os comandos internos falham)
    unmergedPaths = ['src/file.ts']
    allCommandsFail = true

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-unexpected-fail', [
      { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
      { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
      { requestedCommit: 'd'.repeat(40), taskId: 'task-3', databaseTaskId: 3, index: 2 },
    ])

    // Membro 2 isolado (conflito real por degradação)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      index: 1,
      taskId: 'task-2',
      databaseTaskId: 2,
    })

    // cherry-pick --abort foi chamado para o membro conflitante
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(true)

    // Batch não falhou: commit composto existe
    expect(result.commit).toBeTruthy()
  })
})
