/**
 * GateScopePolicy — decide o escopo do gate de verificação por subtarefa.
 *
 * Contexto (2026-08-31, Alexandre): o gate rodava a suíte INTEIRA do monorepo
 * para qualquer subtarefa. Subtarefas simples (ex.: criar config.json) eram
 * reprovadas por testes flaky/quebrados de código que elas nem tocavam.
 *
 * Regras:
 * - Sem alterações no workspace          → pula testes (build já roda antes).
 * - Alteração em arquivo de configuração → suíte cheia (risco transversal).
 * - Caso contrário                       → roda somente os testes afetados
 *   pelos caminhos alterados; se nenhum teste for afetado, pula testes.
 *
 * Teste afetado por um arquivo alterado quando:
 * a) o próprio arquivo alterado é um teste;
 * b) o teste está sob o mesmo diretório do arquivo alterado (ou vice-versa);
 * c) o teste é "irmão" do arquivo alterado (foo.ts → foo.test.ts / foo.spec.ts).
 */

export type GateScopeDecision =
  | { kind: "full"; reason: string }
  | { kind: "scoped"; files: string[]; reason: string }
  | { kind: "skip"; reason: string }

const TEST_DIR_PATTERN = /(^|\/)(test|tests|__tests__)\//
const TEST_FILE_PATTERN = /\.(test|spec)\.[^/]+$/

/** Arquivos cuja alteração pode afetar qualquer teste (configuração transversal). */
const RISKY_PATTERNS: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)vitest\.config\.[^/]+$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.swcrc$/,
  /(^|\/)drizzle\.config\.[^/]+$/,
  /(^|\/)eslint\.config\.[^/]+$/,
]

export function isTestPath(path: string): boolean {
  return TEST_DIR_PATTERN.test(path) || TEST_FILE_PATTERN.test(path)
}

export function isRiskyChange(path: string): boolean {
  return RISKY_PATTERNS.some((pattern) => pattern.test(path))
}

function normalize(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/")
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

/** Nome base sem extensão: src/foo.ts → foo */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.indexOf(".")
  return dot === -1 ? base : base.slice(0, dot)
}

/** Testes do repositório afetados pelas alterações (regras a/b/c do cabeçalho). */
export function affectedTestFiles(
  changedPaths: readonly string[],
  allTestFiles: readonly string[],
): string[] {
  const changed = changedPaths.map(normalize).filter((path) => path.length > 0)
  const affected = new Set<string>()

  for (const testFile of allTestFiles.map(normalize)) {
    const testDir = dirOf(testFile)
    const matched = changed.some((source) => {
      if (isTestPath(source) && source === testFile) return true // (a)
      const sourceDir = dirOf(source)
      if (sourceDir.length > 0 && testDir.length > 0) {
        if (testDir === sourceDir || testDir.startsWith(sourceDir + "/") || sourceDir.startsWith(testDir + "/")) return true // (b)
      }
      // (c) irmão: foo.ts ↔ foo.test.ts / foo.spec.ts (ou sob __tests__ do mesmo dir)
      const stem = stemOf(source)
      if (stem.length > 0 && isTestPath(testFile)) {
        const testBase = testFile.slice(testFile.lastIndexOf("/") + 1)
        if (testBase.startsWith(stem + ".test.") || testBase.startsWith(stem + ".spec.")) {
          const testParent = dirOf(testFile)
          const sourceParent = dirOf(source)
          const testParentUp = testParent.endsWith("__tests__") ? dirOf(testParent) : testParent
          if (testParentUp === sourceParent || testDir === sourceDir) return true
        }
      }
      return false
    })
    if (matched) affected.add(testFile)
  }

  return [...affected].sort()
}

/**
 * Decide o escopo do gate para o conjunto de caminhos alterados.
 * `allTestFiles` = todos os arquivos de teste conhecidos do repositório
 * (ex.: saída de `git ls-files` filtrada por isTestPath).
 */
export function decideGateScope(
  changedPaths: readonly string[],
  allTestFiles: readonly string[],
): GateScopeDecision {
  const changed = changedPaths.map(normalize).filter((path) => path.length > 0)
  if (changed.length === 0) {
    return { kind: "skip", reason: "Nenhuma alteração no workspace; gate de testes dispensado" }
  }
  const risky = changed.filter(isRiskyChange)
  if (risky.length > 0) {
    return { kind: "full", reason: "Alteração em configuração transversal: " + risky.join(", ") }
  }
  const files = affectedTestFiles(changed, allTestFiles)
  if (files.length === 0) {
    return { kind: "skip", reason: "Nenhum teste afetado pelas alterações: " + changed.slice(0, 5).join(", ") }
  }
  return { kind: "scoped", files, reason: files.length + " teste(s) afetado(s) pelas alterações" }
}
