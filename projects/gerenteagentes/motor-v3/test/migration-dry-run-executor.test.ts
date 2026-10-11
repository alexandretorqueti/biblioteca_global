import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { MigrationDryRunError, MigrationDryRunExecutor } from '../src/migrations/MigrationDryRunExecutor.js'

const execFileAsync = promisify(execFile)

describe('MigrationDryRunExecutor', () => {
  let mockPool: Pool
  let querySpy: ReturnType<typeof vi.fn>
  let workspace: string
  const workspaces: string[] = []

  beforeEach(() => {
    querySpy = vi.fn()
    mockPool = {
      query: querySpy,
    } as unknown as Pool
  })

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map(ws => rm(ws, { recursive: true, force: true })))
  })

  async function createWorkspace(): Promise<string> {
    const ws = await mkdtemp(join(tmpdir(), 'motor-v3-dry-run-'))
    workspaces.push(ws)
    await git(ws, ['init', '-b', 'base-desenvolvimento'])
    await git(ws, ['config', 'user.email', 'motor@example.test'])
    await git(ws, ['config', 'user.name', 'Motor Test'])
    workspace = ws
    return ws
  }

  async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
    return stdout
  }

  describe('descoberta diferencial', () => {
    it('não executa quando não há migrations adicionadas', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await writeFile(join(ws, 'projects/alpha/migrations/0001_initial.sql'), 'CREATE TABLE `t1` (`id` INT);')
      await git(ws, ['add', '.'])
      await git(ws, ['commit', '-m', 'baseline'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      const executor = new MigrationDryRunExecutor(mockPool, 123)
      await executor.execute(ws, baseCommit)

      expect(querySpy).not.toHaveBeenCalled()
    })

    it('descobre migrations SQL adicionadas desde o commit-base', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await writeFile(join(ws, 'projects/alpha/migrations/0001_initial.sql'), 'CREATE TABLE `t1` (`id` INT);')
      await git(ws, ['add', '.'])
      await git(ws, ['commit', '-m', 'baseline'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      await writeFile(join(ws, 'projects/alpha/migrations/0002_new.sql'), 'CREATE TABLE `t2` (`id` INT);')

      // Mock SHOW CREATE TABLE (tabela não existe ainda)
      querySpy.mockResolvedValueOnce([[]])
      // Mock execução do CREATE TABLE com nome reescrito
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock cleanup
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 123)
      await executor.execute(ws, baseCommit)

      // Verificar que o CREATE TABLE foi executado com nome reescrito
      const createCall = querySpy.mock.calls.find(call => 
        typeof call[0] === 'string' && call[0].includes('CREATE TABLE') && !call[0].includes('SHOW')
      )
      expect(createCall).toBeDefined()
      expect(createCall![0]).toContain('gate_scratch_123_t2')
    })

    it('ignora migrations não-SQL adicionadas', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['add', '.'])
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      await writeFile(join(ws, 'projects/alpha/migrations/README.md'), '# Migrations')

      const executor = new MigrationDryRunExecutor(mockPool, 123)
      await executor.execute(ws, baseCommit)

      expect(querySpy).not.toHaveBeenCalled()
    })
  })

  describe('reescrita de referências', () => {
    it('reescreve referências de tabela com backticks', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await writeFile(join(ws, 'projects/alpha/migrations/0001_initial.sql'), 'CREATE TABLE `users` (`id` INT);')
      await git(ws, ['add', '.'])
      await git(ws, ['commit', '-m', 'baseline'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      await writeFile(
        join(ws, 'projects/alpha/migrations/0002_insert.sql'),
        'INSERT INTO `users` (`id`) VALUES (1);'
      )

      // Mock SHOW CREATE TABLE (tabela existe)
      querySpy.mockResolvedValueOnce([[{ 'Create Table': 'CREATE TABLE `users` (`id` INT NOT NULL)' }]])
      // Mock CREATE TABLE scratch
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock execução do INSERT reescrito
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock cleanup
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 456)
      await executor.execute(ws, baseCommit)

      // Verificar que o INSERT foi reescrito para usar a tabela scratch
      const insertCall = querySpy.mock.calls[2] // [0]=SHOW, [1]=CREATE scratch, [2]=INSERT
      expect(insertCall).toBeDefined()
      expect(insertCall[0]).toContain('gate_scratch_456_users')
    })
  })

  describe('execução ordenada', () => {
    it('executa múltiplos statements em ordem', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      const multiStatementSql = [
        'CREATE TABLE `t1` (`id` INT);',
        '--> statement-breakpoint',
        'INSERT INTO `t1` (`id`) VALUES (1);',
        '--> statement-breakpoint',
        'INSERT INTO `t1` (`id`) VALUES (2);',
      ].join('\n')
      await writeFile(join(ws, 'projects/alpha/migrations/0001_multi.sql'), multiStatementSql)

      // Mock SHOW CREATE TABLE (tabela não existe)
      querySpy.mockResolvedValueOnce([[]])
      // Mock execução dos 3 statements (CREATE + 2 INSERTs)
      querySpy.mockResolvedValue([{} as ResultSetHeader])
      // Mock cleanup
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 789)
      await executor.execute(ws, baseCommit)

      // Verificar que os 3 statements foram executados (após SHOW CREATE TABLE)
      expect(querySpy).toHaveBeenCalledTimes(5) // 1 SHOW + 3 exec + 1 cleanup
    })
  })

  describe('erro SQL', () => {
    it('reporta erro com arquivo, linha, índice e mensagem MySQL', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      const brokenSql = [
        'CREATE TABLE `t1` (`id` INT);',
        '--> statement-breakpoint',
        'INVALID SQL SYNTAX HERE;',
      ].join('\n')
      await writeFile(join(ws, 'projects/alpha/migrations/0001_broken.sql'), brokenSql)

      // Mock SHOW CREATE TABLE
      querySpy.mockResolvedValueOnce([[]])
      // Mock execução do primeiro statement (sucesso)
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock execução do segundo statement (falha)
      const sqlError = Object.assign(
        new Error("You have an error in your SQL syntax"),
        { errno: 1064, sqlState: '42000' }
      )
      querySpy.mockRejectedValueOnce(sqlError)
      // Mock cleanup
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 999)
      await expect(executor.execute(ws, baseCommit)).rejects.toMatchObject({
        name: 'MigrationDryRunError',
        violations: [{
          project: 'alpha',
          migration: '0001_broken.sql',
          statementIndex: 2,
          mysqlMessage: 'You have an error in your SQL syntax',
          mysqlErrno: 1064,
          mysqlState: '42000',
        }],
      })
    })

    it('limpa tabelas scratch mesmo quando há erro', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      // SQL com referência a tabela para que cloneTableStructures registre scratch
      await writeFile(join(ws, 'projects/alpha/migrations/0001_fail.sql'), 'INSERT INTO `t1` (INVALID);')

      // Mock SHOW CREATE TABLE (tabela não existe)
      querySpy.mockResolvedValueOnce([[]])
      // Mock execução (falha)
      querySpy.mockRejectedValueOnce(new Error('SQL error'))
      // Mock cleanup (deve ser chamado)
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 111)
      await expect(executor.execute(ws, baseCommit)).rejects.toThrow()

      // Verificar que o cleanup foi chamado
      const cleanupCall = querySpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('DROP TABLE IF EXISTS')
      )
      expect(cleanupCall).toBeDefined()
    })
  })

  describe('cleanup', () => {
    it('remove todas as tabelas scratch após sucesso', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      const twoTablesSql = [
        'CREATE TABLE `t1` (`id` INT);',
        '--> statement-breakpoint',
        'CREATE TABLE `t2` (`id` INT);',
      ].join('\n')
      await writeFile(join(ws, 'projects/alpha/migrations/0001_two.sql'), twoTablesSql)

      // Mock SHOW CREATE TABLE (ambas não existem)
      querySpy.mockResolvedValue([[]])
      // Mock CREATE TABLE scratch (ambas)
      querySpy.mockResolvedValue([{} as ResultSetHeader])
      // Mock execução dos statements
      querySpy.mockResolvedValue([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 222)
      await executor.execute(ws, baseCommit)

      // Verificar que o cleanup foi chamado para ambas as tabelas
      const cleanupCalls = querySpy.mock.calls.filter(call =>
        typeof call[0] === 'string' && call[0].includes('DROP TABLE IF EXISTS')
      )
      expect(cleanupCalls.length).toBe(2)
      expect(cleanupCalls[0]![0]).toContain('gate_scratch_222_t1')
      expect(cleanupCalls[1]![0]).toContain('gate_scratch_222_t2')
    })
  })

  describe('clonagem de estrutura', () => {
    it('clona estrutura de tabela existente e remove AUTO_INCREMENT', async () => {
      const ws = await createWorkspace()
      await mkdir(join(ws, 'projects/alpha/migrations'), { recursive: true })
      await git(ws, ['commit', '-m', 'baseline', '--allow-empty'])
      const baseCommit = (await git(ws, ['rev-parse', 'HEAD'])).trim()

      await writeFile(join(ws, 'projects/alpha/migrations/0001_alter.sql'), 'ALTER TABLE `users` ADD COLUMN `name` VARCHAR(100);')

      // Mock SHOW CREATE TABLE (tabela existe com AUTO_INCREMENT)
      querySpy.mockResolvedValueOnce([[{
        'Create Table': 'CREATE TABLE `users` (`id` INT AUTO_INCREMENT, PRIMARY KEY (`id`)) AUTO_INCREMENT=100'
      }]])
      // Mock CREATE TABLE scratch
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock execução do ALTER
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])
      // Mock cleanup
      querySpy.mockResolvedValueOnce([{} as ResultSetHeader])

      const executor = new MigrationDryRunExecutor(mockPool, 333)
      await executor.execute(ws, baseCommit)

      // Verificar que o CREATE TABLE scratch removeu AUTO_INCREMENT
      const createCall = querySpy.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('CREATE TABLE `gate_scratch_333_users`')
      )
      expect(createCall).toBeDefined()
      expect(createCall![0]).toContain('AUTO_INCREMENT=1')
      expect(createCall![0]).not.toContain('AUTO_INCREMENT=100')
    })
  })
})
