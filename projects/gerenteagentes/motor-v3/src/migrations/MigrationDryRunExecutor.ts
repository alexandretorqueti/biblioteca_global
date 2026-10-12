import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

const execFileAsync = promisify(execFile)

export interface MigrationDryRunViolation {
  project: string
  migration: string
  statementIndex: number
  statementLine: number
  mysqlMessage: string
  mysqlErrno?: number
  mysqlState?: string
}

export interface MigrationWatermarkViolation {
  project: string
  migration: string
  entryWhen: number
  databaseWatermark: number
}

/**
 * Incidente task-p2-989 (2026-10-12): `projects/gerenteagentes/migrations` e
 * `projects/gerenteagentes/motor-v3/drizzle/migrations` compartilham a mesma
 * tabela `__drizzle_migrations` no banco do projeto. O migrator do drizzle-kit
 * aplica apenas entradas com `when > MAX(created_at)` (watermark); a migration
 * interna 0009 (when=1791810000000) elevou o watermark acima da 0086 do
 * projeto (when=1791678000002, colidindo ainda com o when da 0008) e o
 * drizzle-kit PULOU a 0086 em silêncio — o deploy "sucedeu" sem as colunas
 * novas e o código que as escreve foi ao ar. Este erro reprova o gate quando
 * uma migration adicionada tem `when` <= watermark atual do banco alvo.
 */
export class MigrationWatermarkError extends Error {
  constructor(readonly violations: MigrationWatermarkViolation[]) {
    super([
      'Migrations com `when` <= watermark de __drizzle_migrations — o drizzle-kit PULARIA a aplicação em silêncio:',
      ...violations.map(v =>
        `- projects/${v.project}/migrations/${v.migration} (when=${v.entryWhen} <= watermark=${v.databaseWatermark})`,
      ),
      'Ajuste o `when` da entrada no meta/_journal.json para um valor MAIOR que o watermark atual do banco.',
      'Causa típica: dois folders de migration compartilham __drizzle_migrations no mesmo banco (incidente task-p2-989).',
    ].join('\n'))
    this.name = 'MigrationWatermarkError'
  }
}

export class MigrationDryRunError extends Error {
  constructor(readonly violations: MigrationDryRunViolation[]) {
    super([
      'Dry-run de migrations falhou em tabelas scratch:',
      ...violations.map(v =>
        `- projects/${v.project}/migrations/${v.migration} (statement ${v.statementIndex}, linha ${v.statementLine}): ${v.mysqlMessage}${v.mysqlErrno ? ` [errno=${v.mysqlErrno}]` : ''}`
      ),
      'Corrija os erros de SQL antes de concluir a entrega.',
    ].join('\n'))
    this.name = 'MigrationDryRunError'
  }
}

/**
 * Executor de dry-run diferencial para migrations adicionadas desde o commit-base.
 * 
 * Estratégia: tabelas scratch prefixadas (gate_scratch_<jobId>_<tableName>)
 * - Clona somente a estrutura das tabelas tocadas (SHOW CREATE TABLE + rewrite)
 * - Reescreve referências SQL para os nomes scratch
 * - Executa statements em ordem sobre as tabelas scratch
 * - Remove artefatos em finally após sucesso ou falha
 * 
 * Decisão documentada: tabelas scratch em vez de database separado porque
 * o usuário MYSQL_* pode não ter grants para CREATE DATABASE. Isolamento
 * por database é uma evolução futura quando grants forem expandidos.
 */
export class MigrationDryRunExecutor {
  private readonly scratchPrefix: string
  private readonly scratchTables: string[] = []

  constructor(
    private readonly pool: Pool,
    private readonly jobId: number,
  ) {
    this.scratchPrefix = `gate_scratch_${jobId}_`
  }

  /**
   * Executa dry-run das migrations adicionadas desde baseCommitSha.
   * Descobre, clona estrutura, reescreve SQL, executa e limpa em finally.
   */
  async execute(
    workspacePath: string,
    baseCommitSha: string,
  ): Promise<void> {
    const addedMigrations = await this.discoverAddedMigrations(workspacePath, baseCommitSha)
    if (addedMigrations.length === 0) return

    await this.validateJournalWatermarks(workspacePath, addedMigrations)

    try {
      for (const { project, migration, path } of addedMigrations) {
        const content = await readFile(resolve(workspacePath, path), 'utf8')
        const statements = this.splitStatements(content)
        if (statements.length === 0) continue

        const touchedTables = this.extractTableNames(statements)
        await this.cloneTableStructures(touchedTables)

        for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
          const statement = statements[statementIndex]!
          const rewritten = this.rewriteTableReferences(statement, touchedTables)
          const statementLine = this.findStatementLine(content, statement)

          try {
            await this.pool.query(rewritten)
          } catch (error: any) {
            throw new MigrationDryRunError([{
              project,
              migration,
              statementIndex: statementIndex + 1,
              statementLine,
              mysqlMessage: error.message || String(error),
              mysqlErrno: error.errno,
              mysqlState: error.sqlState,
            }])
          }
        }
      }
    } finally {
      await this.cleanupScratchTables()
    }
  }

  /**
   * Descobre migrations SQL adicionadas desde o commit-base usando git diff + untracked.
   * Combina tracked (adicionados desde base) e untracked (nunca commitados).
   */
  private async discoverAddedMigrations(
    workspacePath: string,
    baseCommitSha: string,
  ): Promise<Array<{ project: string; migration: string; path: string }>> {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execFileAsync(
        'git',
        ['diff', '--name-only', '--diff-filter=A', baseCommitSha, '--'],
        { cwd: workspacePath, encoding: 'utf8' },
      ),
      execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: workspacePath, encoding: 'utf8' },
      ),
    ])
    const allPaths = [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))]
    const migrations: Array<{ project: string; migration: string; path: string }> = []
    for (const path of allPaths) {
      const match = /^projects\/([^/]+)\/migrations\/([^/]+\.sql)$/.exec(path)
      if (match) {
        migrations.push({ project: match[1]!, migration: match[2]!, path })
      }
    }
    return migrations
  }

  /**
   * Valida o `when` das entradas de journal das migrations adicionadas contra o
   * watermark atual (MAX(created_at)) de `__drizzle_migrations` no banco alvo.
   * O migrator do drizzle aplica apenas entradas com when > watermark; quando
   <= watermark a migration é PULADA em silêncio (incidente task-p2-989).
   * Entradas sem journal/sem tag correspondente são ignoradas aqui — o gate
   * MigrationJournalIntegrity já as reprova em separado.
   */
  private async validateJournalWatermarks(
    workspacePath: string,
    addedMigrations: Array<{ project: string; migration: string; path: string }>,
  ): Promise<void> {
    interface JournalEntry { tag: string; when: number }
    const entriesByProject = new Map<string, JournalEntry[]>()
    const candidates: Array<{ project: string; migration: string; when: number }> = []
    for (const added of addedMigrations) {
      let entries = entriesByProject.get(added.project)
      if (entries === undefined) {
        entries = []
        try {
          const journalPath = resolve(workspacePath, 'projects', added.project, 'migrations', 'meta', '_journal.json')
          const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries?: JournalEntry[] }
          if (Array.isArray(journal.entries)) entries = journal.entries
        } catch {
          // journal ausente/ilegível: MigrationJournalIntegrity reprova em separado.
        }
        entriesByProject.set(added.project, entries)
      }
      const tag = added.migration.replace(/\.sql$/, '')
      const entry = entries.find(candidate => candidate.tag === tag)
      if (entry && Number.isFinite(entry.when)) {
        candidates.push({ project: added.project, migration: added.migration, when: entry.when })
      }
    }
    if (candidates.length === 0) return

    let watermark: number | null = null
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        'SELECT MAX(created_at) AS watermark FROM `__drizzle_migrations`',
      )
      const raw = rows[0]?.['watermark']
      watermark = raw === null || raw === undefined ? null : Number(raw)
    } catch (error) {
      // Tabela ainda não existe (banco novo): não há watermark, nada a validar.
      if (MigrationDryRunExecutor.isMissingTableError(error)) return
      throw error
    }
    if (watermark === null) return

    const violations = candidates
      .filter(candidate => candidate.when <= watermark)
      .map(candidate => ({
        project: candidate.project,
        migration: candidate.migration,
        entryWhen: candidate.when,
        databaseWatermark: watermark as number,
      }))
    if (violations.length > 0) throw new MigrationWatermarkError(violations)
  }

  /**
   * Divide conteúdo SQL em statements usando `--> statement-breakpoint` como separador.
   * Blocos que contêm apenas comentários ou whitespace são descartados.
   */
  private splitStatements(content: string): string[] {
    return content
      .split(/\r?\n-->\s*statement-breakpoint\r?\n/)
      .map(block => block.trim())
      .filter(block => {
        if (block.length === 0) return false
        // Verificar se há conteúdo SQL real (não apenas comentários de linha)
        const sqlLines = block.split(/\r?\n/).filter(line => {
          const trimmed = line.trim()
          return trimmed.length > 0 && !trimmed.startsWith('--')
        })
        return sqlLines.length > 0
      })
  }

  /**
   * Extrai nomes de tabelas referenciadas nos statements.
   * Detecta CREATE TABLE, ALTER TABLE, INSERT INTO, UPDATE, DELETE FROM,
   * FROM e JOIN (tabelas lidas por UPDATE/INSERT ... SELECT também precisam
   * ser clonadas e reescritas para o dry-run não tocar tabelas reais).
   */
  private extractTableNames(statements: string[]): Set<string> {
    const tables = new Set<string>()
    const patterns = [
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi,
      /ALTER\s+TABLE\s+`?(\w+)`?/gi,
      /INSERT\s+INTO\s+`?(\w+)`?/gi,
      /UPDATE\s+`?(\w+)`?/gi,
      /DELETE\s+FROM\s+`?(\w+)`?/gi,
      /\bFROM\s+`?(\w+)`?/gi,
      /\bJOIN\s+`?(\w+)`?/gi,
    ]
    for (const statement of statements) {
      for (const pattern of patterns) {
        let match
        while ((match = pattern.exec(statement)) !== null) {
          tables.add(match[1]!)
        }
      }
    }
    return tables
  }

  /**
   * Clona a estrutura das tabelas tocadas para versões scratch prefixadas.
   * Tabelas que ainda não existem são registradas mas não clonadas — o dry-run
   * validará a sintaxe do CREATE TABLE original durante a execução.
   *
   * Incidente task-p2-989 (2026-10-12): o clone reexecutava o SHOW CREATE TABLE
   * com as CONSTRAINTs de FOREIGN KEY nomeadas — no MySQL o nome da FK é único
   * por schema, então o clone falhava com errno 1826 e o `catch {}` engolia o
   * erro. O statement seguinte falhava com 1146 (scratch inexistente), um
   * sintoma enganoso que reprovava qualquer migration sobre tabela com FK.
   * Agora: FKs são removidas do clone (integridade referencial é irrelevante
   * para o dry-run de sintaxe) e falhas de clone não são mais silenciosas —
   * apenas "tabela não existe" (1146/1051) e "clone já criado nesta execução"
   * (1050, migrations do mesmo dry-run tocando a mesma tabela) são tolerados.
   */
  private async cloneTableStructures(tables: Set<string>): Promise<void> {
    for (const tableName of tables) {
      const scratchName = `${this.scratchPrefix}${tableName}`
      this.scratchTables.push(scratchName)
      let createStatement: string | undefined
      try {
        const [rows] = await this.pool.query<RowDataPacket[]>(
          `SHOW CREATE TABLE \`${tableName}\``,
        )
        createStatement = rows[0]?.['Create Table'] as string | undefined
      } catch (error) {
        // Tabela pode não existir ainda (primeira migration que a cria).
        // Nesse caso, o dry-run validará a sintaxe do CREATE TABLE original.
        if (MigrationDryRunExecutor.isMissingTableError(error)) continue
        throw error
      }
      if (!createStatement) continue
      const rewritten = this.buildScratchCreateStatement(createStatement, tableName, scratchName)
      try {
        await this.pool.query(rewritten)
      } catch (error) {
        // Duas migrations do mesmo dry-run podem tocar a mesma tabela: o clone
        // da segunda encontra a scratch já criada (1050) — não é falha.
        if ((error as { errno?: number })?.errno === 1050) continue
        throw new MigrationDryRunError([{
          project: 'scratch-clone',
          migration: tableName,
          statementIndex: 0,
          statementLine: 0,
          mysqlMessage: `Falha ao clonar estrutura de \`${tableName}\` para \`${scratchName}\`: ${(error as Error)?.message ?? String(error)}`,
          mysqlErrno: (error as { errno?: number })?.errno,
          mysqlState: (error as { sqlState?: string })?.sqlState,
        }])
      }
    }
  }

  /** 1146 = table doesn't exist; 1051 = unknown table (DROP). */
  private static isMissingTableError(error: unknown): boolean {
    const errno = (error as { errno?: number })?.errno
    return errno === 1146 || errno === 1051
  }

  /**
   * Reescreve o SHOW CREATE TABLE para o nome scratch, removendo FOREIGN KEYs
   * nomeadas (duplicariam o nome da constraint no schema) e normalizando o
   * AUTO_INCREMENT. O formato do SHOW CREATE TABLE coloca cada constraint em
   * uma linha própria, então a remoção é linha a linha + ajuste da vírgula
   * pendurada antes do fechamento.
   */
  private buildScratchCreateStatement(createStatement: string, tableName: string, scratchName: string): string {
    const withoutForeignKeys = createStatement
      .split('\n')
      .filter(line => !/^\s*(?:CONSTRAINT\s+`[^`]*`\s+)?FOREIGN\s+KEY\b/i.test(line))
      .join('\n')
      .replace(/,(\s*\))/g, '$1')
    return withoutForeignKeys
      .replace(new RegExp(`CREATE TABLE \`${tableName}\``, 'i'), `CREATE TABLE \`${scratchName}\``)
      .replace(/AUTO_INCREMENT=\d+/gi, 'AUTO_INCREMENT=1')
  }

  /**
   * Reescreve referências de tabelas para os nomes scratch.
   */
  private rewriteTableReferences(statement: string, tables: Set<string>): string {
    let rewritten = statement
    for (const tableName of tables) {
      const scratchName = `${this.scratchPrefix}${tableName}`
      // Substituir referências com backticks ou sem
      rewritten = rewritten
        .replace(new RegExp(`\`${tableName}\``, 'g'), `\`${scratchName}\``)
        .replace(new RegExp(`\\b${tableName}\\b`, 'g'), scratchName)
    }
    return rewritten
  }

  /**
   * Encontra o número da linha onde o statement começa (1-indexed).
   */
  private findStatementLine(content: string, statement: string): number {
    const lines = content.split(/\r?\n/)
    const statementFirstLine = statement.split(/\r?\n/)[0]!.trim()
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.trim() === statementFirstLine) {
        return index + 1
      }
    }
    return 1
  }

  /**
   * Remove todas as tabelas scratch criadas.
   */
  private async cleanupScratchTables(): Promise<void> {
    for (const scratchTable of this.scratchTables) {
      try {
        await this.pool.query(`DROP TABLE IF EXISTS \`${scratchTable}\``)
      } catch {
        // Cleanup best-effort: logar mas não falhar o gate
      }
    }
  }
}
