import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const migrationPath = /^projects\/([^/]+)\/migrations\/([^/]+\.sql)$/

export interface MigrationJournalProblem {
  project: string
  migration: string
  expectedTag: string
}

export interface MigrationJournalMonotonicityViolation {
  project: string
  entryTag: string
  entryIndex: number
  currentWhen: number
  previousWhen: number
  previousTag: string
}

export interface StatementBreakpointViolation {
  project: string
  migration: string
  orphanedStatementLine: number
  statementCount: number
  breakpointCount: number
  /**
   * `missing_breakpoint`: 2+ statements no mesmo bloco sem separador (incidente 0082).
   * `empty_segment`: separador pendurado/consecutivo gera bloco vazio — o drizzle
   * executa uma query vazia, a migration falha DEPOIS do DDL já aplicado (commit
   * implícito do MySQL) e não é registrada: retry vira loop de "table already
   * exists" (incidente task-p2-984, migration 0085).
   */
  kind: 'missing_breakpoint' | 'empty_segment'
}

export interface MigrationJournalInspection {
  project: string
  orphaned: MigrationJournalProblem[]
  monotonicityViolations: MigrationJournalMonotonicityViolation[]
  issue?: 'journal_missing' | 'journal_unreadable' | 'journal_invalid_json' | 'journal_invalid_structure'
}

export class MigrationJournalIntegrityError extends Error {
  constructor(readonly problems: MigrationJournalProblem[], readonly inspections: MigrationJournalInspection[]) {
    super([
      'Migrations SQL adicionadas sem a tag correspondente no meta/_journal.json:',
      ...problems.map(problem => `- projects/${problem.project}/migrations/${problem.migration} (tag esperada: ${problem.expectedTag})`),
      'Gere/atualize o journal junto com cada migration antes de concluir a entrega.',
    ].join('\n'))
    this.name = 'MigrationJournalIntegrityError'
  }
}

export class MigrationJournalMonotonicityError extends Error {
  constructor(readonly violations: MigrationJournalMonotonicityViolation[], readonly inspections: MigrationJournalInspection[]) {
    super([
      'Journal de migrations com valores "when" não monotônicos (devem ser estritamente crescentes):',
      ...violations.map(violation =>
        `- projects/${violation.project}/migrations/meta/_journal.json: entrada ${violation.entryIndex} (tag "${violation.entryTag}") tem when=${violation.currentWhen}, mas a entrada anterior (tag "${violation.previousTag}") tem when=${violation.previousWhen}. Orientação: use when=${violation.previousWhen + 1000} ou superior.`
      ),
      'Corrija os timestamps do journal antes de concluir a entrega.',
    ].join('\n'))
    this.name = 'MigrationJournalMonotonicityError'
  }
}

export class MigrationStatementBreakpointError extends Error {
  constructor(readonly violations: StatementBreakpointViolation[]) {
    super([
      'Migrations SQL com blocos malformados (separator "--> statement-breakpoint"): ',
      ...violations.map(violation => violation.kind === 'empty_segment'
        ? `- projects/${violation.project}/migrations/${violation.migration}: "--> statement-breakpoint" na linha ${violation.orphanedStatementLine} gera um bloco VAZIO (pendurado no fim do arquivo ou consecutivo). O drizzle executa uma query vazia, a migration falha depois do DDL já aplicado (commit implícito do MySQL) e não é registrada — o retry vira loop de "table already exists" no deploy. Remova o separador excedente; o arquivo deve terminar com o ";" do último statement.`
        : `- projects/${violation.project}/migrations/${violation.migration}: ${violation.statementCount} statements encontrados, ${violation.breakpointCount} breakpoint(s). Statement órfão inicia na linha ${violation.orphanedStatementLine}. Adicione "--> statement-breakpoint" entre statements consecutivos (referência: 0027_motor_configuracoes.sql).`
      ),
      'O drizzle-kit CLI envia cada bloco como query única sem multipleStatements — blocos com múltiplos statements OU blocos vazios causam falha no deploy.',
    ].join('\n'))
    this.name = 'MigrationStatementBreakpointError'
  }
}

/** Retorna a raiz do monorepo tanto em src/ quanto no build em dist/. */
export const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

export async function inspectProjectMigrationJournal(
  repositoryRoot: string,
  project: string,
  migrations?: string[],
): Promise<MigrationJournalInspection> {
  const migrationDirectory = resolve(repositoryRoot, 'projects', project, 'migrations')
  const names = migrations ?? await sqlMigrations(migrationDirectory)
  const journalPath = resolve(migrationDirectory, 'meta', '_journal.json')
  let journal: unknown
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'))
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      project,
      orphaned: names.map(migration => problem(project, migration)),
      monotonicityViolations: [],
      issue: code === 'ENOENT' ? 'journal_missing' : error instanceof SyntaxError ? 'journal_invalid_json' : 'journal_unreadable',
    }
  }
  if (!isJournal(journal)) {
    return { project, orphaned: names.map(migration => problem(project, migration)), monotonicityViolations: [], issue: 'journal_invalid_structure' }
  }
  const tags = new Set(journal.entries.map(entry => entry.tag))
  const orphaned = names.filter(name => !tags.has(tagFor(name))).map(migration => problem(project, migration))
  const monotonicityViolations = validateMonotonicity(project, journal.entries)
  return { project, orphaned, monotonicityViolations }
}

/** Varre todos os projetos acessíveis. Diretórios sem migrations são ignorados. */
export async function inspectMigrationJournals(repositoryRoot = defaultRepositoryRoot): Promise<MigrationJournalInspection[]> {
  let projects: string[]
  try { projects = await readdir(resolve(repositoryRoot, 'projects')) } catch { return [] }
  const inspections = await Promise.all(projects.map(async project => {
    const directory = resolve(repositoryRoot, 'projects', project, 'migrations')
    try { await readdir(directory) } catch { return null }
    return inspectProjectMigrationJournal(repositoryRoot, project)
  }))
  return inspections.filter((inspection): inspection is MigrationJournalInspection => inspection !== null)
}

/**
 * Gate diferencial: apenas migrations adicionadas desde o commit-base podem
 * bloquear a entrega. Pendências anteriores continuam visíveis no boot, mas
 * não reprovam uma subtarefa que não as introduziu.
 */
export async function assertAddedMigrationsHaveJournalEntries(workspacePath: string, baseCommit: string): Promise<void> {
  const added = await addedMigrationPaths(workspacePath, baseCommit)
  const byProject = new Map<string, string[]>()
  const addedSqlPaths: Array<{ project: string; migration: string; path: string }> = []
  for (const path of added) {
    const match = migrationPath.exec(path)
    if (!match) continue
    const [, project, migration] = match
    if (!project || !migration) continue
    byProject.set(project, [...(byProject.get(project) ?? []), migration])
    addedSqlPaths.push({ project, migration, path })
  }
  const inspections = await Promise.all([...byProject.entries()].map(([project, migrations]) =>
    inspectProjectMigrationJournal(workspacePath, project, migrations),
  ))
  const problems = inspections.flatMap(inspection => inspection.orphaned)
  if (problems.length > 0) throw new MigrationJournalIntegrityError(problems, inspections)
  const monotonicityViolations = inspections.flatMap(inspection => inspection.monotonicityViolations)
  if (monotonicityViolations.length > 0) throw new MigrationJournalMonotonicityError(monotonicityViolations, inspections)
  // Gate de statement-breakpoint: verifica se migrations com múltiplos statements
  // adicionadas desde o commit-base possuem o separador "--> statement-breakpoint".
  const breakpointViolations = await inspectAddedMigrationStatementBreakpoints(workspacePath, addedSqlPaths)
  if (breakpointViolations.length > 0) throw new MigrationStatementBreakpointError(breakpointViolations)
}

/** Preflight observável e deliberadamente não fatal para pendências históricas. */
export async function warnOnMigrationJournalIntegrity(repositoryRoot = defaultRepositoryRoot): Promise<MigrationJournalInspection[]> {
  const inspections = await inspectMigrationJournals(repositoryRoot)
  for (const inspection of inspections) {
    if (inspection.orphaned.length === 0 && inspection.monotonicityViolations.length === 0 && !inspection.issue) continue
    console.warn(JSON.stringify({
      event: 'migration_journal_integrity_warning',
      project: inspection.project,
      issue: inspection.issue ?? null,
      orphanedMigrations: inspection.orphaned.map(orphan => ({ file: orphan.migration, expectedTag: orphan.expectedTag })),
      monotonicityViolations: inspection.monotonicityViolations.map(violation => ({
        entryTag: violation.entryTag,
        entryIndex: violation.entryIndex,
        currentWhen: violation.currentWhen,
        previousWhen: violation.previousWhen,
        previousTag: violation.previousTag,
      })),
      fatal: false,
    }))
  }
  return inspections
}

async function addedMigrationPaths(workspacePath: string, baseCommit: string): Promise<string[]> {
  const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '--diff-filter=A', baseCommit, '--'], { cwd: workspacePath, encoding: 'utf8' }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: workspacePath, encoding: 'utf8' }),
  ])
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))]
}

async function sqlMigrations(directory: string): Promise<string[]> {
  try { return (await readdir(directory)).filter(name => name.endsWith('.sql')) } catch { return [] }
}

function tagFor(migration: string): string { return migration.slice(0, -'.sql'.length) }
function problem(project: string, migration: string): MigrationJournalProblem {
  return { project, migration, expectedTag: tagFor(migration) }
}
function isJournal(value: unknown): value is { entries: Array<{ tag: string; when: number }> } {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as { entries?: unknown }).entries)
    && (value as { entries: unknown[] }).entries.every(entry =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as { tag?: unknown }).tag === 'string'
      && typeof (entry as { when?: unknown }).when === 'number'
    )
}

function validateMonotonicity(project: string, entries: Array<{ tag: string; when: number }>): MigrationJournalMonotonicityViolation[] {
  const violations: MigrationJournalMonotonicityViolation[] = []
  for (let index = 1; index < entries.length; index++) {
    const current = entries[index]!
    const previous = entries[index - 1]!
    if (current.when <= previous.when) {
      violations.push({
        project,
        entryTag: current.tag,
        entryIndex: index,
        currentWhen: current.when,
        previousWhen: previous.when,
        previousTag: previous.tag,
      })
    }
  }
  return violations
}

/**
 * Analisa migrations SQL adicionadas e exige `--> statement-breakpoint` entre
 * statements consecutivos. Somente arquivos novos desde o commit-base são
 * verificados (gate diferencial).
 */
async function inspectAddedMigrationStatementBreakpoints(
  workspacePath: string,
  addedSqlPaths: Array<{ project: string; migration: string; path: string }>,
): Promise<StatementBreakpointViolation[]> {
  const violations: StatementBreakpointViolation[] = []
  for (const { project, migration, path } of addedSqlPaths) {
    let content: string
    try {
      content = await readFile(resolve(workspacePath, path), 'utf8')
    } catch {
      continue
    }
    violations.push(...statementBreakpointViolationsFor(project, migration, analyzeStatementBreakpoints(content)))
  }
  return violations
}

/**
 * Conta statements top-level e breakpoints em conteúdo SQL.
 * Retorna `violationLine` (linha 1-indexed do statement órfão) ou null se OK,
 * e `emptySegmentLine` (linha do marcador que inicia um bloco vazio — pendurado
 * no fim do arquivo, consecutivo ou antes do primeiro statement) ou null se OK.
 *
 * Um statement é terminado por `;` fora de strings, identificadores delimitados
 * ou comentários. O marcador `--> statement-breakpoint` separa blocos; cada
 * bloco deve conter exatamente 1 statement.
 */
export function analyzeStatementBreakpoints(sqlContent: string): {
  statementCount: number
  breakpointCount: number
  violationLine: number | null
  emptySegmentLine: number | null
} {
  const lines = sqlContent.split(/\r?\n/)
  let statementCount = 0
  let breakpointCount = 0
  let violationLine: number | null = null
  // Linha do último marcador de breakpoint visto (início do segmento corrente).
  let lastBreakpointLine: number | null = null
  // Linha de um segmento vazio (entre breakpoints consecutivos, antes do
  // primeiro breakpoint sem statement anterior, ou após o último breakpoint
  // no fim do arquivo) — o drizzle executaria uma query vazia e falharia.
  let emptySegmentLine: number | null = null

  // State machine: track whether we're inside a string/comment
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  // Track statements within segments separated by breakpoints.
  // After a semicolon ends a statement, the next non-whitespace content
  // without an intervening breakpoint is a violation.
  let statementsSinceLastBreakpoint = 0
  let awaitingNextStatement = false // true after a semicolon, before next content
  let nextContentLine: number | null = null // line where next statement would start

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!
    const lineNumber = lineIndex + 1

    // Check if this line is a statement-breakpoint marker
    const trimmedLine = line.trim()
    if (trimmedLine === '--> statement-breakpoint') {
      breakpointCount++
      // Segmento que termina neste marcador não contém nenhum statement:
      // bloco vazio (breakpoint pendurado/consecutivo) → query vazia no drizzle.
      if (statementsSinceLastBreakpoint === 0 && emptySegmentLine === null) {
        emptySegmentLine = lastBreakpointLine ?? lineNumber
      }
      lastBreakpointLine = lineNumber
      // Reset the segment counter — new segment starts after breakpoint
      statementsSinceLastBreakpoint = 0
      awaitingNextStatement = false
      nextContentLine = null
      // Skip processing this line as SQL content
      continue
    }

    inLineComment = false // line comments reset at each new line

    for (let col = 0; col < line.length; col++) {
      const ch = line[col]!
      const next = col + 1 < line.length ? line[col + 1] : ''

      // Handle block comment state
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          col++ // skip '/'
        }
        continue
      }

      // Handle line comment state
      if (inLineComment) {
        continue // rest of line is comment
      }

      // Handle string states
      if (inSingleQuote) {
        if (ch === '\\') {
          col++ // skip escaped character
          continue
        }
        if (ch === "'" && next === "'") {
          col++ // skip escaped quote ('')
          continue
        }
        if (ch === "'") {
          inSingleQuote = false
        }
        continue
      }

      if (inDoubleQuote) {
        if (ch === '\\') {
          col++ // skip escaped character
          continue
        }
        if (ch === '"' && next === '"') {
          col++ // skip escaped quote ("")
          continue
        }
        if (ch === '"') {
          inDoubleQuote = false
        }
        continue
      }

      if (inBacktick) {
        if (ch === '`' && next === '`') {
          col++ // skip escaped backtick (``)
          continue
        }
        if (ch === '`') {
          inBacktick = false
        }
        continue
      }

      // Normal state — detect transitions
      if (ch === '-' && next === '-') {
        inLineComment = true
        continue
      }

      if (ch === '/' && next === '*') {
        inBlockComment = true
        col++ // skip '*'
        continue
      }

      if (ch === "'") {
        inSingleQuote = true
        // This is content — track for next-statement detection
        if (awaitingNextStatement && nextContentLine === null) {
          nextContentLine = lineNumber
        }
        continue
      }

      if (ch === '"') {
        inDoubleQuote = true
        if (awaitingNextStatement && nextContentLine === null) {
          nextContentLine = lineNumber
        }
        continue
      }

      if (ch === '`') {
        inBacktick = true
        if (awaitingNextStatement && nextContentLine === null) {
          nextContentLine = lineNumber
        }
        continue
      }

      if (ch === ';') {
        // End of a statement
        statementCount++
        statementsSinceLastBreakpoint++
        awaitingNextStatement = true
        nextContentLine = null
        continue
      }

      // Any non-whitespace character is content
      if (!/\s/.test(ch)) {
        if (awaitingNextStatement && nextContentLine === null) {
          nextContentLine = lineNumber
        }
      }
    }

    // After processing the line, check if we found content after a semicolon
    // without an intervening breakpoint
    if (awaitingNextStatement && nextContentLine !== null && nextContentLine === lineNumber) {
      // There is content on this line after a semicolon — check if there was a
      // semicolon earlier on THIS line that ended a statement, and this content
      // starts a new one. But we need to be careful: the semicolon and the new
      // content are on the same line.
      // Actually, the simpler check: after processing the whole line, if
      // statementsSinceLastBreakpoint > 1, we have a violation.
    }

    // Check for multi-statement violation within this segment.
    // If we've seen > 1 statement since the last breakpoint, the 2nd statement
    // is orphaned.
    if (statementsSinceLastBreakpoint > 1 && violationLine === null) {
      // The orphaned statement starts at nextContentLine (the first content
      // after the first semicolon in this segment).
      violationLine = nextContentLine ?? lineNumber
    }
  }

  // Breakpoint no fim do arquivo: o segmento final (após o último marcador)
  // não tem statements → o drizzle executa uma query vazia e a migration
  // falha sem ser registrada (incidente task-p2-984, migration 0085).
  if (breakpointCount > 0 && statementsSinceLastBreakpoint === 0 && emptySegmentLine === null) {
    emptySegmentLine = lastBreakpointLine ?? lines.length
  }

  return { statementCount, breakpointCount, violationLine, emptySegmentLine }
}

/**
 * Função pública para inspecionar breakpoints em um arquivo SQL individual.
 * Útil para testes e para o preflight não-fatal.
 */
export async function inspectMigrationStatementBreakpoints(
  repositoryRoot: string,
  project: string,
  migrations?: string[],
): Promise<StatementBreakpointViolation[]> {
  const migrationDirectory = resolve(repositoryRoot, 'projects', project, 'migrations')
  let names: string[]
  if (migrations) {
    names = migrations
  } else {
    names = await sqlMigrations(migrationDirectory)
  }
  const violations: StatementBreakpointViolation[] = []
  for (const migration of names) {
    let content: string
    try {
      content = await readFile(resolve(migrationDirectory, migration), 'utf8')
    } catch {
      continue
    }
    violations.push(...statementBreakpointViolationsFor(project, migration, analyzeStatementBreakpoints(content)))
  }
  return violations
}

/** Converte o resultado do analyzer em violações tipadas (um push por problema). */
function statementBreakpointViolationsFor(
  project: string,
  migration: string,
  result: ReturnType<typeof analyzeStatementBreakpoints>,
): StatementBreakpointViolation[] {
  const violations: StatementBreakpointViolation[] = []
  if (result.violationLine !== null) {
    violations.push({
      project,
      migration,
      orphanedStatementLine: result.violationLine,
      statementCount: result.statementCount,
      breakpointCount: result.breakpointCount,
      kind: 'missing_breakpoint',
    })
  }
  if (result.emptySegmentLine !== null) {
    violations.push({
      project,
      migration,
      orphanedStatementLine: result.emptySegmentLine,
      statementCount: result.statementCount,
      breakpointCount: result.breakpointCount,
      kind: 'empty_segment',
    })
  }
  return violations
}
