/**
 * Atribuição de culpa em falha de gate pre_deploy do commit composto.
 *
 * Quando o gate do batch falha, o motor precisa identificar QUAL membro
 * introduziu a falha para bloquear somente ele e re-compor o lote com os
 * inocentes (incidente 2026-10-23: 13 tarefas bloqueadas por 1 migration
 * quebrada e 1 erro de compilação).
 *
 * A atribuição é por evidência de caminho de arquivo:
 * 1. `test_failures.source_file` (falhas estruturadas do gate);
 * 2. caminhos extraídos do stdout/stderr do gate (erros de tsc, FAIL de
 *    vitest, listas de dry-run de migration, caminhos repo-root).
 *
 * Regra conservadora: sem evidência, sem caminho por membro, culpados == todos
 * os membros ou culpados == vazio → NÃO atribui (bloqueia o batch inteiro,
 * comportamento histórico). Nunca isolar um inocente é mais importante do que
 * sempre isolar um culpado.
 */

export interface GateEvidenceInput {
  stdout: string
  stderr: string
  buildCommand?: string | null
  testCommand?: string | null
}

export interface AttributionResult {
  /** databaseTaskId dos membros cuja mudança tocou os arquivos da falha. */
  culprits: number[]
  /** Pares (membro, arquivo) que fundamentam cada culpa — para auditoria. */
  matches: Array<{ databaseTaskId: number; evidencePath: string; memberFile: string }>
}

/** Diretórios raiz do monorepo: caminhos começando neles já são repo-relative. */
const ROOT_DIRS = ['projects/', 'apps/', 'packages/', 'infra/', 'scripts/', 'docs/', 'tools/']

/**
 * Extrai o prefixo `cd <dir> &&` dos comandos de gate: erros de compiladores
 * (tsc, esbuild) saem relativos ao cwd do comando, não à raiz do repositório.
 */
export function extractCwdPrefixes(commands: Array<string | null | undefined>): string[] {
  const prefixes: string[] = []
  for (const command of commands) {
    if (!command) continue
    // Todos os `cd X` do comando (podem ser encadeados com && ou ;)
    for (const match of command.matchAll(/(?:^|&&|;|\|)\s*cd\s+([^\s&;|]+)/g)) {
      const dir = match[1]!.replace(/\/+$/, '')
      if (dir && !prefixes.includes(dir)) prefixes.push(dir)
    }
  }
  return prefixes
}

function isRepoRooted(path: string): boolean {
  return ROOT_DIRS.some(root => path.startsWith(root))
}

/**
 * Resolve um caminho de erro para um caminho repo-relative.
 * - Já repo-rooted → como está.
 * - Relativo + cwd conhecido → junta com cada prefixo (todas as combinações
 *   candidatas; o matching por sufixo tolera múltiplos).
 * - Relativo sem cwd → como está (matching por sufixo resolve).
 */
export function resolveEvidencePath(path: string, cwdPrefixes: string[]): string[] {
  const clean = path.replace(/^\.\//, '').replace(/^\/+/, '')
  if (!clean) return []
  if (isRepoRooted(clean)) return [clean]
  if (cwdPrefixes.length === 0) return [clean]
  return cwdPrefixes.map(prefix => `${prefix}/${clean}`)
}

/**
 * Extrai caminhos de arquivo citados no stdout/stderr do gate.
 * Padrões cobertos (incidentes reais):
 * - tsc: `src/start.ts(645,11): error TS2304: ...`
 * - vitest/jest: `FAIL projects/x/test/y.test.ts` / `❯ src/foo.ts`
 * - dry-run de migration: `- projects/x/migrations/0001_y.sql (statement 3, ...)`
 * - genérico: qualquer caminho repo-rooted com extensão de código/config.
 */
export function extractFailurePaths(input: GateEvidenceInput): string[] {
  const cwdPrefixes = extractCwdPrefixes([input.buildCommand, input.testCommand])
  const text = `${input.stdout}\n${input.stderr}`
  const raw = new Set<string>()

  // tsc: caminho(line,col): error|warning
  for (const match of text.matchAll(/(?:^|\n)\s*([^\s:()]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs))\((\d+),(\d+)\):\s*(?:error|warning)/g)) {
    raw.add(match[1]!)
  }
  // vitest/jest: FAIL <arquivo> (com ou sem suíte entre >)
  for (const match of text.matchAll(/(?:FAIL|❯|✗|×)\s+([^\s>]+\.(?:tsx?|jsx?|mjs|cjs))(?:\s|$|>)/gm)) {
    raw.add(match[1]!)
  }
  // Bullet de dry-run de migration / listas `- projects/...sql`
  for (const match of text.matchAll(/^-\s+((?:projects|apps|packages)\/[^\s(]+\.sql)/gm)) {
    raw.add(match[1]!)
  }
  // Genérico repo-rooted: paths iniciando em diretório raiz do monorepo
  for (const match of text.matchAll(/((?:projects|apps|packages|infra)\/[\w.@+/-]+\.(?:tsx?|jsx?|sql|json|css|scss|md|ya?ml))/g)) {
    raw.add(match[1]!)
  }

  const resolved = new Set<string>()
  for (const path of raw) {
    for (const candidate of resolveEvidencePath(path, cwdPrefixes)) resolved.add(candidate)
  }
  return [...resolved]
}

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Match por igualdade ou sufixo com fronteira de diretório (tolera cwd relativo). */
export function pathsMatch(memberFile: string, evidencePath: string): boolean {
  const a = normalize(memberFile)
  const b = normalize(evidencePath)
  if (!a || !b) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Cruza evidências com os arquivos alterados por membro.
 * @param memberFiles mapa databaseTaskId → arquivos alterados pelo membro
 * @param evidencePaths caminhos de evidência (source_file + extraídos do log)
 */
export function attributeGateFailure(
  memberFiles: Map<number, string[]>,
  evidencePaths: string[],
): AttributionResult | null {
  if (memberFiles.size < 2) return null
  if (evidencePaths.length === 0) return null
  const matches: AttributionResult['matches'] = []
  const culprits = new Set<number>()
  for (const [databaseTaskId, files] of memberFiles) {
    for (const evidencePath of evidencePaths) {
      const memberFile = files.find(file => pathsMatch(file, evidencePath))
      if (memberFile) {
        culprits.add(databaseTaskId)
        matches.push({ databaseTaskId, evidencePath, memberFile })
        break
      }
    }
  }
  // Sem culpado identificado OU todos os membros são culpados → não isola.
  if (culprits.size === 0 || culprits.size >= memberFiles.size) return null
  return { culprits: [...culprits], matches }
}
