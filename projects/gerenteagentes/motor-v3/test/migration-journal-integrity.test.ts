import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeStatementBreakpoints,
  assertAddedMigrationsHaveJournalEntries,
  inspectMigrationJournals,
  inspectMigrationStatementBreakpoints,
  inspectProjectMigrationJournal,
  MigrationJournalIntegrityError,
  MigrationJournalMonotonicityError,
  MigrationStatementBreakpointError,
  warnOnMigrationJournalIntegrity,
} from '../src/migrations/MigrationJournalIntegrity.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('MigrationJournalIntegrity', () => {
  it('exige correspondência exata entre nome SQL e tag', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_exact.sql'], tags: ['0001_different'], whens: [1000] } })
    const inspection = await inspectProjectMigrationJournal(root, 'alpha')
    expect(inspection.orphaned).toEqual([{ project: 'alpha', migration: '0001_exact.sql', expectedTag: '0001_exact' }])
    expect(inspection.monotonicityViolations).toEqual([])
  })

  it('reconhece migration registrada e deixa explícito journal inválido ou ausente', async () => {
    const root = await fixture({
      registered: { migrations: ['0001_registered.sql'], tags: ['0001_registered'], whens: [1000] },
      absent: { migrations: ['0002_absent.sql'] },
      malformed: { migrations: ['0003_malformed.sql'], rawJournal: '{invalid' },
    })
    await expect(inspectProjectMigrationJournal(root, 'registered')).resolves.toMatchObject({ orphaned: [], monotonicityViolations: [] })
    await expect(inspectProjectMigrationJournal(root, 'absent')).resolves.toMatchObject({ issue: 'journal_missing', monotonicityViolations: [] })
    await expect(inspectProjectMigrationJournal(root, 'malformed')).resolves.toMatchObject({ issue: 'journal_invalid_json', monotonicityViolations: [] })
  })

  it('no gate só reprova SQL adicionado desde o commit-base', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_historical.sql'], tags: [], whens: [] } })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).resolves.toBeUndefined()
    await writeFile(join(root, 'projects/alpha/migrations/0002_new.sql'), '-- new')
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationJournalIntegrityError',
      problems: [{ project: 'alpha', migration: '0002_new.sql', expectedTag: '0002_new' }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow('Gere/atualize o journal junto com cada migration')
  })

  it('bloqueia journal com when não monotônico (menor ou igual ao anterior)', async () => {
    const root = await fixture({
      monotonic: {
        migrations: ['0001_first.sql', '0002_second.sql', '0003_third.sql'],
        tags: ['0001_first', '0002_second', '0003_third'],
        whens: [1000, 2000, 3000],
      },
      non_monotonic: {
        migrations: ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
        tags: ['0001_a', '0002_b', '0003_c'],
        whens: [1000, 2000, 1500], // violação: 1500 < 2000
      },
    })
    const inspectionMonotonic = await inspectProjectMigrationJournal(root, 'monotonic')
    expect(inspectionMonotonic.monotonicityViolations).toEqual([])
    const inspectionNonMonotonic = await inspectProjectMigrationJournal(root, 'non_monotonic')
    expect(inspectionNonMonotonic.monotonicityViolations).toHaveLength(1)
    expect(inspectionNonMonotonic.monotonicityViolations[0]).toMatchObject({
      project: 'non_monotonic',
      entryTag: '0003_c',
      entryIndex: 2,
      currentWhen: 1500,
      previousWhen: 2000,
      previousTag: '0002_b',
    })
  })

  it('bloqueia journal com when igual ao anterior', async () => {
    const root = await fixture({
      equal: {
        migrations: ['0001_a.sql', '0002_b.sql'],
        tags: ['0001_a', '0002_b'],
        whens: [1000, 1000], // violação: igual
      },
    })
    const inspection = await inspectProjectMigrationJournal(root, 'equal')
    expect(inspection.monotonicityViolations).toHaveLength(1)
    expect(inspection.monotonicityViolations[0]).toMatchObject({
      project: 'equal',
      entryTag: '0002_b',
      currentWhen: 1000,
      previousWhen: 1000,
    })
  })

  it('gate reprova journal não monotônico adicionado desde o commit-base', async () => {
    const root = await fixture({
      alpha: {
        migrations: ['0001_ok.sql', '0002_ok.sql'],
        tags: ['0001_ok', '0002_ok'],
        whens: [1000, 2000],
      },
    })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).resolves.toBeUndefined()

    // Adicionar nova migration com when não monotônico
    await writeFile(join(root, 'projects/alpha/migrations/0003_new.sql'), '-- new')
    const journalPath = join(root, 'projects/alpha/migrations/meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries.push({ tag: '0003_new', when: 1500 }) // menor que 2000
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationJournalMonotonicityError',
      violations: [{
        project: 'alpha',
        entryTag: '0003_new',
        currentWhen: 1500,
        previousWhen: 2000,
        previousTag: '0002_ok',
      }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow(/when=1500.*when=2000.*use when=3000/)
  })

  it('gate reprova migration adicionada com múltiplos statements sem breakpoint', async () => {
    const root = await fixture({
      alpha: {
        migrations: ['0001_ok.sql'],
        tags: ['0001_ok'],
        whens: [1000],
      },
    })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).resolves.toBeUndefined()

    // Migration com 2 statements sem breakpoint (reproduz o incidente 0082)
    const brokenSql = [
      'CREATE TABLE IF NOT EXISTS `motor_postdeploy_verifications` (',
      '  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,',
      '  PRIMARY KEY (`id`)',
      ');',
      'INSERT INTO `motor_configuracoes` (`chave`, `tipo`, `valor`, `valor_padrao`, `regra_validacao`, `descricao`)',
      "VALUES ('motor.postdeploy.active', 'boolean', 'true', 'true', '', 'Ativa verificação');",
    ].join('\n')
    await writeFile(join(root, 'projects/alpha/migrations/0002_broken.sql'), brokenSql)
    // Atualizar journal para não falhar no journal check primeiro
    const journalPath = join(root, 'projects/alpha/migrations/meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries.push({ tag: '0002_broken', when: 2000 })
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationStatementBreakpointError',
      violations: [{
        project: 'alpha',
        migration: '0002_broken.sql',
        statementCount: 2,
        breakpointCount: 0,
      }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow(/statement-breakpoint.*0027_motor_configuracoes\.sql/)
  })

  it('gate reprova migration adicionada com breakpoint pendurado no fim (incidente task-p2-984)', async () => {
    const root = await fixture({
      alpha: {
        migrations: ['0001_ok.sql'],
        tags: ['0001_ok'],
        whens: [1000],
      },
    })
    await git(root, ['init', '-b', 'base-desenvolvimento'])
    await git(root, ['config', 'user.email', 'motor@example.test'])
    await git(root, ['config', 'user.name', 'Motor Test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'baseline'])
    const base = (await git(root, ['rev-parse', 'HEAD'])).trim()

    // Migration com CREATE TABLE + breakpoint pendurado no fim do arquivo
    // (formato exato do incidente 0085_realtime_event_outbox.sql)
    const danglingSql = [
      'CREATE TABLE `realtime_event_outbox` (',
      '  `id` BIGINT NOT NULL AUTO_INCREMENT,',
      '  PRIMARY KEY (`id`)',
      ');',
      '--> statement-breakpoint',
      '',
    ].join('\n')
    await writeFile(join(root, 'projects/alpha/migrations/0002_dangling.sql'), danglingSql)
    const journalPath = join(root, 'projects/alpha/migrations/meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries.push({ tag: '0002_dangling', when: 2000 })
    await writeFile(journalPath, JSON.stringify(journal))

    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toMatchObject({
      name: 'MigrationStatementBreakpointError',
      violations: [{
        project: 'alpha',
        migration: '0002_dangling.sql',
        kind: 'empty_segment',
        orphanedStatementLine: 5,
      }],
    })
    await expect(assertAddedMigrationsHaveJournalEntries(root, base)).rejects.toThrow(/bloco VAZIO/)
  })

  it('preflight avisa sem falhar e separa múltiplos projetos', async () => {
    const root = await fixture({
      alpha: { migrations: ['0001_orphan.sql'], tags: [], whens: [] },
      beta: { migrations: ['0002_ok.sql'], tags: ['0002_ok'], whens: [1000] },
      gamma: { migrations: ['0003_orphan.sql'] },
      delta: {
        migrations: ['0001_a.sql', '0002_b.sql'],
        tags: ['0001_a', '0002_b'],
        whens: [2000, 1000], // não monotônico
      },
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const inspections = await warnOnMigrationJournalIntegrity(root)
    expect(inspections).toHaveLength(4)
    expect(inspections.flatMap(inspection => inspection.orphaned).map(problem => problem.project).sort()).toEqual(['alpha', 'gamma'])
    expect(inspections.flatMap(inspection => inspection.monotonicityViolations).map(v => v.project)).toEqual(['delta'])
    expect(warning).toHaveBeenCalledTimes(3)
    expect(warning.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'alpha', fatal: false }),
      expect.objectContaining({ event: 'migration_journal_integrity_warning', project: 'gamma', issue: 'journal_missing', fatal: false }),
      expect.objectContaining({
        event: 'migration_journal_integrity_warning',
        project: 'delta',
        monotonicityViolations: expect.arrayContaining([
          expect.objectContaining({ entryTag: '0002_b', currentWhen: 1000, previousWhen: 2000 }),
        ]),
        fatal: false,
      }),
    ]))
    warning.mockRestore()
    await expect(inspectMigrationJournals(root)).resolves.toHaveLength(4)
  })
})

describe('analyzeStatementBreakpoints', () => {
  it('detecta dois statements sem breakpoint como violação', () => {
    const sql = [
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ');',
      'INSERT INTO `teste` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(2)
    expect(result.breakpointCount).toBe(0)
    expect(result.violationLine).toBe(5) // INSERT começa na linha 5
  })

  it('aceita dois statements separados por breakpoint', () => {
    const sql = [
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ');',
      '--> statement-breakpoint',
      'INSERT INTO `teste` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(2)
    expect(result.breakpointCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('aceita migration com um único statement', () => {
    const sql = [
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ');',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.breakpointCount).toBe(0)
    expect(result.violationLine).toBeNull()
  })

  it('ignora ponto-e-vírgula dentro de comentários de linha', () => {
    const sql = [
      '-- Este comentário tem um ; no meio',
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL',
      ');',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.breakpointCount).toBe(0)
    expect(result.violationLine).toBeNull()
  })

  it('ignora ponto-e-vírgula dentro de comentários de bloco', () => {
    const sql = [
      '/* este bloco tem ; e ; vários ; */',
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL',
      ');',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('ignora ponto-e-vírgula dentro de strings single-quoted', () => {
    const sql = [
      "INSERT INTO `teste` (`valor`) VALUES ('hello;world');",
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('ignora ponto-e-vírgula dentro de strings double-quoted', () => {
    const sql = [
      'INSERT INTO `teste` (`valor`) VALUES ("hello;world");',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('ignora ponto-e-vírgula dentro de identificadores backtick', () => {
    const sql = [
      'CREATE TABLE `hello;world` (',
      '  `id` INT NOT NULL',
      ');',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('aceita três statements com dois breakpoints (padrão 0027)', () => {
    const sql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      'CREATE TABLE `t2` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      'INSERT INTO `t1` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(3)
    expect(result.breakpointCount).toBe(2)
    expect(result.violationLine).toBeNull()
  })

  it('detecta violação quando breakpoint está presente mas falta um', () => {
    const sql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      'CREATE TABLE `t2` (`id` INT NOT NULL);',
      'INSERT INTO `t1` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(3)
    expect(result.breakpointCount).toBe(1)
    expect(result.violationLine).toBe(4) // INSERT na linha 4
  })

  it('ignora conteúdo vazio ou apenas comentários', () => {
    const sql = [
      '-- Apenas um comentário',
      '/* e um bloco */',
      '',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(0)
    expect(result.breakpointCount).toBe(0)
    expect(result.violationLine).toBeNull()
  })

  it('reporta a linha correta do statement órfão', () => {
    const sql = [
      '-- Migration: teste',
      '',
      'CREATE TABLE `teste` (',
      '  `id` INT NOT NULL,',
      '  PRIMARY KEY (`id`)',
      ');',
      'INSERT INTO `teste` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(2)
    expect(result.violationLine).toBe(7) // INSERT na linha 7
  })

  it('trata string com escape de aspas duplicadas', () => {
    const sql = [
      "INSERT INTO `teste` (`valor`) VALUES ('it''s a ;test');",
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.violationLine).toBeNull()
  })

  it('detecta breakpoint pendurado no fim do arquivo (reproduz incidente 0085/task-p2-984)', () => {
    const sql = [
      '-- comentário',
      'CREATE TABLE `realtime_event_outbox` (',
      '  `id` BIGINT NOT NULL AUTO_INCREMENT,',
      '  PRIMARY KEY (`id`)',
      ') ENGINE=InnoDB;',
      '--> statement-breakpoint',
      '',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(1)
    expect(result.breakpointCount).toBe(1)
    expect(result.violationLine).toBeNull()
    expect(result.emptySegmentLine).toBe(6) // linha do marcador pendurado
  })

  it('detecta breakpoints consecutivos (bloco vazio entre marcadores)', () => {
    const sql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      '--> statement-breakpoint',
      'INSERT INTO `t1` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.statementCount).toBe(2)
    expect(result.breakpointCount).toBe(2)
    expect(result.emptySegmentLine).toBe(2) // primeiro marcador do par consecutivo
  })

  it('não marca segmento vazio em arquivo bem formado com múltiplos blocos', () => {
    const sql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      'INSERT INTO `t1` (`id`) VALUES (1);',
    ].join('\n')
    const result = analyzeStatementBreakpoints(sql)
    expect(result.violationLine).toBeNull()
    expect(result.emptySegmentLine).toBeNull()
  })
})

describe('inspectMigrationStatementBreakpoints', () => {
  it('detecta violações em migrations de um projeto', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_ok.sql'], tags: ['0001_ok'], whens: [1000] } })
    // Sobrescrever o conteúdo com SQL válido e SQL quebrado
    const okSql = 'CREATE TABLE `t1` (`id` INT NOT NULL);'
    const brokenSql = [
      'CREATE TABLE `t2` (`id` INT NOT NULL);',
      'INSERT INTO `t2` (`id`) VALUES (1);',
    ].join('\n')
    await writeFile(join(root, 'projects/alpha/migrations/0001_ok.sql'), okSql)
    await writeFile(join(root, 'projects/alpha/migrations/0002_broken.sql'), brokenSql)

    const violations = await inspectMigrationStatementBreakpoints(root, 'alpha')
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      project: 'alpha',
      migration: '0002_broken.sql',
      statementCount: 2,
      breakpointCount: 0,
    })
    expect(violations[0]!.orphanedStatementLine).toBe(2)
  })

  it('retorna array vazio quando todas as migrations estão corretas', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_ok.sql'], tags: ['0001_ok'], whens: [1000] } })
    const okSql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      'INSERT INTO `t1` (`id`) VALUES (1);',
    ].join('\n')
    await writeFile(join(root, 'projects/alpha/migrations/0001_ok.sql'), okSql)

    const violations = await inspectMigrationStatementBreakpoints(root, 'alpha', ['0001_ok.sql'])
    expect(violations).toEqual([])
  })

  it('detecta bloco vazio por breakpoint pendurado no fim do arquivo', async () => {
    const root = await fixture({ alpha: { migrations: ['0001_ok.sql'], tags: ['0001_ok'], whens: [1000] } })
    const danglingSql = [
      'CREATE TABLE `t1` (`id` INT NOT NULL);',
      '--> statement-breakpoint',
      '',
    ].join('\n')
    await writeFile(join(root, 'projects/alpha/migrations/0001_ok.sql'), danglingSql)

    const violations = await inspectMigrationStatementBreakpoints(root, 'alpha', ['0001_ok.sql'])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      project: 'alpha',
      migration: '0001_ok.sql',
      kind: 'empty_segment',
      orphanedStatementLine: 2,
    })
  })
})

async function fixture(projects: Record<string, { migrations: string[]; tags?: string[]; whens?: number[]; rawJournal?: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-journal-'))
  roots.push(root)
  for (const [project, config] of Object.entries(projects)) {
    const migrationDirectory = join(root, 'projects', project, 'migrations')
    await mkdir(migrationDirectory, { recursive: true })
    await Promise.all(config.migrations.map(name => writeFile(join(migrationDirectory, name), '-- migration')))
    if (config.rawJournal !== undefined) {
      await mkdir(join(migrationDirectory, 'meta'), { recursive: true })
      await writeFile(join(migrationDirectory, 'meta', '_journal.json'), config.rawJournal)
    } else if (config.tags !== undefined) {
      await mkdir(join(migrationDirectory, 'meta'), { recursive: true })
      const entries = config.tags.map((tag, index) => ({
        tag,
        when: config.whens?.[index] ?? (index + 1) * 1000,
      }))
      await writeFile(join(migrationDirectory, 'meta', '_journal.json'), JSON.stringify({ entries }))
    }
  }
  return root
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout
}
