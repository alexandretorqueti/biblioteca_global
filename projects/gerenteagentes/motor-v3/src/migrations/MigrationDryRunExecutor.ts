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
  /** Pool em uso na iteração corrente (por projeto); padrão = pool do construtor. */
  private activePool: Pool

  constructor(
    private readonly pool: Pool,
    private readonly jobId: number,
    /**
     * Resolve o banco alvo por projeto da migration (slug do diretório
     * projects/<slug>). Incidente tarefa 1097 (2026-11-20): tarefa do projeto
     * biblioteca-global (projeto_1, vazio) adicionou migration do projeto
     * gerenteagentes (banco real projeto_640); o dry-run usava o banco do
     * projeto da TAREFA e o fallback de cadeia completa simulava o alvo
     * errado. Sem resolver (ou null) mantém o pool do construtor.
     */
    private readonly projectPoolResolver?: (project: string) => Promise<{ pool: Pool; owned: boolean } | null>,
  ) {
    this.scratchPrefix = `gate_scratch_${jobId}_`
    this.activePool = pool
  }

  /**
   * Executa dry-run das migrations adicionadas desde baseCommitSha.
   * Descobre, clona estrutura, reescreve SQL, executa e limpa em finally.
   *
   * Banco alvo vazio (projeto novo, nunca deployado — incidente 2026-10-23,
   * gestao-de-tarefas-global): o modo diferencial falha com errno 1146 porque
   * as migrations anteriores (que criam as tabelas referenciadas) nunca foram
   * aplicadas. Nesse caso o dry-run reinicia simulando a CADEIA COMPLETA do
   * projeto em scratch, na ordem do journal — exatamente o que o deploy
   * aplicaria. O fallback só dispara com falha 1146 + banco comprovadamente
   * vazio; qualquer outro erro preserva o comportamento histórico.
   */
  async execute(
    workspacePath: string,
    baseCommitSha: string,
  ): Promise<void> {
    const addedMigrations = await this.discoverAddedMigrations(workspacePath, baseCommitSha)
    if (addedMigrations.length === 0) return

    const projects = [...new Set(addedMigrations.map(migration => migration.project))]
    for (const project of projects) {
      const forProject = addedMigrations.filter(migration => migration.project === project)
      // O banco alvo segue o PROJETO DA MIGRATION, não o projeto da tarefa do
      // gate (incidente tarefa 1097). Resolver ausente/sem mapeamento → pool
      // legado do construtor.
      const resolved = (await this.projectPoolResolver?.(project)) ?? null
      this.activePool = resolved?.pool ?? this.pool
      try {
        await this.validateJournalWatermarks(workspacePath, forProject)

        try {
          await this.executeDifferential(workspacePath, forProject)
        } catch (error) {
          const missingScratch = error instanceof MigrationDryRunError
            && error.violations.length > 0
            && error.violations.every(violation => violation.mysqlErrno === 1146)
          if (!missingScratch || !await this.isFreshTargetDatabase()) throw error
          // Banco vazio: limpa resquícios do modo diferencial e simula a cadeia
          // completa (as migrations anteriores criarão as tabelas em scratch).
          await this.cleanupScratchTables()
          this.scratchTables.length = 0
          await this.executeFullChain(workspacePath, project, forProject)
        }
      } finally {
        await this.cleanupScratchTables()
        this.scratchTables.length = 0
        this.activePool = this.pool
        if (resolved?.owned) await resolved.pool.end().catch(() => undefined)
      }
    }
  }

  /** Modo diferencial histórico: somente as migrations adicionadas, com clone das tabelas reais tocadas. */
  private async executeDifferential(
    workspacePath: string,
    addedMigrations: Array<{ project: string; migration: string; path: string }>,
  ): Promise<void> {
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
          await this.activePool.query(rewritten)
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
  }

  /**
   * Banco alvo totalmente vazio (nenhuma tabela): primeiro deploy do projeto.
   * Indeterminável por erro de consulta → falso (mantém o modo diferencial,
   * comportamento histórico).
   */
  private async isFreshTargetDatabase(): Promise<boolean> {
    try {
      const [rows] = await this.activePool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = DATABASE()',
      )
      return Number(rows[0]?.['total'] ?? -1) === 0
    } catch {
      return false
    }
  }

  /**
   * Simula a cadeia completa de migrations do projeto (journal, ordem por idx)
   * em tabelas scratch, sem clonar do banco real (vazio). Erros de estrutura
   * já existente na própria cadeia (1050) e de nome de FK já usado na cadeia
   * (1826) são tolerados — o objetivo é validar o encadeamento até as
   * migrations adicionadas, não duplicar validações de unicidade do drizzle.
   * Journal ausente/ilegível → degrada para as migrations adicionadas.
   */
  private async executeFullChain(
    workspacePath: string,
    project: string,
    addedForProject: Array<{ project: string; migration: string; path: string }>,
  ): Promise<void> {
    let chain: Array<{ project: string; migration: string; path: string }> = []
    try {
      const journalPath = resolve(workspacePath, 'projects', project, 'migrations', 'meta', '_journal.json')
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries?: Array<{ idx: number; tag: string }> }
      if (Array.isArray(journal.entries)) {
        chain = [...journal.entries]
          .sort((a, b) => a.idx - b.idx)
          .map(entry => ({
            project,
            migration: `${entry.tag}.sql`,
            path: `projects/${project}/migrations/${entry.tag}.sql`,
          }))
      }
    } catch {
      chain = []
    }
    const migrations = chain.length > 0 ? chain : addedForProject
    for (const { migration, path } of migrations) {
      let content: string
      try {
        content = await readFile(resolve(workspacePath, path), 'utf8')
      } catch {
        // Arquivo ausente (lacuna do journal): nada a simular.
        continue
      }
      const statements = this.splitStatements(content)
      if (statements.length === 0) continue
      const touchedTables = this.extractTableNames(statements)
      // Sem clone do banco real (vazio): registra scratch para o cleanup.
      for (const tableName of touchedTables) {
        const scratchName = `${this.scratchPrefix}${tableName}`
        if (!this.scratchTables.includes(scratchName)) this.scratchTables.push(scratchName)
      }
      for (let statementIndex = 0; statementIndex < statements.length; statementIndex++) {
        const statement = statements[statementIndex]!
        const rewritten = this.rewriteTableReferences(statement, touchedTables)
        const statementLine = this.findStatementLine(content, statement)
        try {
          await this.activePool.query(rewritten)
        } catch (error: any) {
          // 1050/1826: estrutura já existente na própria cadeia. 1304: stored
          // procedure residual de execução anterior (o nome do objeto não é
          // prefixado como as tabelas scratch) — incidente tarefa 1097.
          if (error?.errno === 1050 || error?.errno === 1826 || error?.errno === 1304) continue
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
      const [rows] = await this.activePool.query<RowDataPacket[]>(
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
   *
   * O separador é o próprio marcador, sem exigir que esteja em linha exclusiva:
   * o drizzle-kit emite `;--> statement-breakpoint` na MESMA linha do `;`
   * anterior (ex.: cadeia de ALTER TABLE ADD CONSTRAINT da migration 0000 de
   * gerenteagentes). Ancorar em `\n` antes do marcador colava todos esses
   * statements num bloco só e o MySQL falhava com 1064 no trecho
   * `--> statement-breakpoint` (incidente tarefas 1097/1098, 2026-11-19/20,
   * pre_deploy migration-dry-run). O migrator do drizzle faz split pela
   * string exata do marcador — aqui seguimos o mesmo contrato.
   */
  private splitStatements(content: string): string[] {
    return content
      .split(/-->\s*statement-breakpoint/)
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
    // Incidente task-p2-1056 (2026-11-01): comentário de migration contendo
    // "CREATE TABLE + ALTER TABLE ADD COLUMN" fazia o padrão ALTER capturar
    // "ADD" como nome de tabela; o rewrite então corrompia todo `ADD COLUMN`
    // do statement seguinte (gate reprovava SQL válido com errno 1064).
    // Extração sempre opera sobre o SQL sem comentários.
    statements = statements.map(statement => this.stripSqlComments(statement))
    // Schemas de sistema nunca são tabelas do projeto. Incidente tarefa 1097
    // (2026-11-20): `FROM information_schema.table_constraints` (stored
    // procedure da migration 0003) extraía `information_schema` e o rewrite o
    // transformava num schema scratch inexistente (errno 1142 no pre_deploy).
    const systemSchemas = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])
    // O lookahead `(?![\w.`])` rejeita referências qualificadas `schema.tabela`
    // (o `\w+` não pode parar no meio do identificador nem capturar o schema)
    // e é imune a backtracking parcial.
    const patterns = [
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?(?![\w.`])/gi,
      /ALTER\s+TABLE\s+`?(\w+)`?(?![\w.`])/gi,
      // Modificadores (IGNORE/LOW_PRIORITY/...) entre INSERT e INTO não podem
      // impedir a captura: sem ela a tabela não era reescrita e o dry-run
      // escrevia na tabela REAL do projeto (INSERT IGNORE INTO
      // `prompts_mascaras` da migration 0021 — incidente tarefa 1097).
      /INSERT\s+(?:(?:IGNORE|LOW_PRIORITY|HIGH_PRIORITY|DELAYED)\s+)*INTO\s+`?(\w+)`?(?![\w.`])/gi,
      // UPDATE precisa iniciar uma instrução/linha. Sem a âncora, o trecho
      // `ON UPDATE CURRENT_TIMESTAMP` de uma coluna era interpretado como se
      // CURRENT_TIMESTAMP fosse uma tabela e acabava reescrito para scratch.
      /^\s*UPDATE\s+`?(\w+)`?(?![\w.`])/gim,
      /DELETE\s+FROM\s+`?(\w+)`?(?![\w.`])/gi,
      /\bFROM\s+`?(\w+)`?(?![\w.`])/gi,
      /\bJOIN\s+`?(\w+)`?(?![\w.`])/gi,
      // REFERENCES de FOREIGN KEY precisa ser reescrito para scratch: na cadeia
      // completa o banco alvo está vazio e a FK apontaria para a tabela real
      // inexistente (errno 1824 — incidente tarefa 1097, migration 0009).
      /\bREFERENCES\s+`?(\w+)`?(?![\w.`])/gi,
      // Primeiro argumento (nome de tabela) dos procedures auxiliares do
      // projeto: `CALL __bg_ensure_column('tarefas', ...)`. A tabela pertence
      // à cadeia mas não aparece em nenhum outro padrão deste arquivo; sem a
      // extração o literal não é reescrito e o ALTER dinâmico do procedure
      // falha com errno 1146 sobre a tabela real inexistente (incidente
      // tarefa 1097, migration 0013). O rewrite de palavra nua já substitui
      // o literal entre aspas — a extração é a única peça faltante.
      /CALL\s+`?__bg_ensure_(?:column|index)`?\s*\(\s*'(\w+)'/gi,
    ]
    for (const statement of statements) {
      for (const pattern of patterns) {
        let match
        while ((match = pattern.exec(statement)) !== null) {
          const tableName = match[1]!
          if (systemSchemas.has(tableName.toLowerCase())) continue
          tables.add(tableName)
        }
      }
    }
    return tables
  }

  /**
   * Remove comentários SQL (linhas `--`/`#` e blocos de comentário) para
   * análise estática (extração de nomes de tabela). Respeita string literals
   * (aspas simples/duplas) e identificadores com backtick: `--`/`#` dentro
   * de strings não iniciam comentário. `--` só comenta quando seguido de
   * espaço/fim-de-linha (sintaxe MySQL). O texto retornado é usado apenas
   * para extração — o statement executado preserva o conteúdo original.
   */
  private stripSqlComments(sql: string): string {
    const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const lines: string[] = []
    for (const line of withoutBlockComments.split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('--') || trimmed.startsWith('#')) continue
      lines.push(this.cutInlineComment(line))
    }
    return lines.join('\n')
  }

  /** Corta comentário de linha (`-- ` ou `#`) fora de strings/backticks. */
  private cutInlineComment(line: string): string {
    let inSingle = false
    let inDouble = false
    let inBacktick = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '\\' && (inSingle || inDouble)) { i++; continue }
      if (!inDouble && !inBacktick && ch === "'") { inSingle = !inSingle; continue }
      if (!inSingle && !inBacktick && ch === '"') { inDouble = !inDouble; continue }
      if (!inSingle && !inDouble && ch === '`') { inBacktick = !inBacktick; continue }
      if (inSingle || inDouble || inBacktick) continue
      if (ch === '#') return line.slice(0, i)
      if (ch === '-' && line[i + 1] === '-' && (line[i + 2] === undefined || /\s/.test(line[i + 2]!))) {
        return line.slice(0, i)
      }
    }
    return line
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
        const [rows] = await this.activePool.query<RowDataPacket[]>(
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
        await this.activePool.query(rewritten)
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
   * Remove todas as tabelas scratch criadas, em ordem reversa de registro e
   * com FOREIGN_KEY_CHECKS desligado quando há conexão dedicada disponível.
   * FKs entre tabelas scratch fazem o DROP na ordem de criação falhar
   * (errno 3730/ordem arbitrária) e deixar resíduos no banco alvo — e
   * `isFreshTargetDatabase()` conta tabelas, então resíduo desligaria o
   * fallback de cadeia completa de execuções futuras.
   */
  private async cleanupScratchTables(): Promise<void> {
    if (this.scratchTables.length === 0) return
    const ordered = [...this.scratchTables].reverse()
    // SET FOREIGN_KEY_CHECKS vale por sessão: exige conexão dedicada. Mocks de
    // teste expõem só `query` — nesse caso degrada para a ordem reversa.
    if (typeof this.activePool.getConnection === 'function') {
      let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined
      try {
        connection = await this.activePool.getConnection()
        await connection.query('SET FOREIGN_KEY_CHECKS=0')
        for (const scratchTable of ordered) {
          try {
            await connection.query(`DROP TABLE IF EXISTS \`${scratchTable}\``)
          } catch {
            // Cleanup best-effort: logar mas não falhar o gate
          }
        }
        await connection.query('SET FOREIGN_KEY_CHECKS=1')
      } catch {
        // Conexão indisponível: tenta o caminho simples abaixo
        for (const scratchTable of ordered) {
          try {
            await this.activePool.query(`DROP TABLE IF EXISTS \`${scratchTable}\``)
          } catch {
            // Cleanup best-effort
          }
        }
      } finally {
        connection?.release()
      }
      return
    }
    for (const scratchTable of ordered) {
      try {
        await this.activePool.query(`DROP TABLE IF EXISTS \`${scratchTable}\``)
      } catch {
        // Cleanup best-effort: logar mas não falhar o gate
      }
    }
  }
}
