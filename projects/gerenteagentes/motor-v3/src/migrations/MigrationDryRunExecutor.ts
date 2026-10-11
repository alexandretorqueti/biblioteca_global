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
   * Detecta CREATE TABLE, ALTER TABLE, INSERT INTO, UPDATE, DELETE FROM.
   */
  private extractTableNames(statements: string[]): Set<string> {
    const tables = new Set<string>()
    const patterns = [
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi,
      /ALTER\s+TABLE\s+`?(\w+)`?/gi,
      /INSERT\s+INTO\s+`?(\w+)`?/gi,
      /UPDATE\s+`?(\w+)`?/gi,
      /DELETE\s+FROM\s+`?(\w+)`?/gi,
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
   */
  private async cloneTableStructures(tables: Set<string>): Promise<void> {
    for (const tableName of tables) {
      const scratchName = `${this.scratchPrefix}${tableName}`
      this.scratchTables.push(scratchName)
      try {
        const [rows] = await this.pool.query<RowDataPacket[]>(
          `SHOW CREATE TABLE \`${tableName}\``,
        )
        if (!rows[0]) continue
        const createStatement = rows[0]['Create Table'] as string
        const rewritten = createStatement
          .replace(new RegExp(`CREATE TABLE \`${tableName}\``, 'i'), `CREATE TABLE \`${scratchName}\``)
          .replace(/AUTO_INCREMENT=\d+/gi, 'AUTO_INCREMENT=1')
        await this.pool.query(rewritten)
      } catch {
        // Tabela pode não existir ainda (primeira migration que a cria).
        // Nesse caso, o dry-run validará a sintaxe do CREATE TABLE original.
      }
    }
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
