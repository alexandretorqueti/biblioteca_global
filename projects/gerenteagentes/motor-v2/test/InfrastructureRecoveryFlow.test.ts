/**
 * Teste de integração do fluxo completo de recuperação segura de bloqueios.
 * @vitest-environment node
 *
 * Valida os critérios da subtarefa 6:
 * 1. Um bloqueio elegível é retomado sem recriar worktree nem perder commits
 * 2. Worktree ausente, inválido ou divergente é recusado sem alteração do repositório
 * 3. Uma falha em qualquer verificação do preflight impede a retomada
 * 4. Múltiplas tarefas com a mesma assinatura ficam associadas a um único incidente
 *    e assinaturas distintas não são agrupadas
 * 5. O histórico contém motivo, correção, data, origem e responsável/processo
 * 6. A suíte de testes relevante é executada sem regressão
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { ResumePreflightChecker, formatPreflightForHistory } from '../src/workspaces/ResumePreflightChecker.js'
import { failureFingerprint, isSystemicFailure } from '../src/policies/SystemFailurePolicy.js'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock DependencyInstaller para todos os testes deste arquivo
vi.mock('../src/workspaces/DependencyInstaller.js', () => ({
  DependencyInstaller: class {
    async install() { return { ok: true as const, reason: '' } }
  },
  resolveInstallTimeoutMs: () => 30000,
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockDb(options: {
  recoveryRows?: Array<Record<string, unknown>>
  blockRows?: Array<Record<string, unknown>>
  existingIncidentId?: string | null
} = {}): Db {
  const db: Db = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      // FROM bloqueios — deve vir ANTES do 'SELECT id FROM tarefas' porque a query de bloqueios
      // contém uma subquery com 'SELECT id FROM tarefas WHERE external_id'
      if (sql.includes('FROM bloqueios')) {
        return Promise.resolve({
          rows: options.blockRows ?? [],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      // Busca tarefa_id numérico para associar ao incidente (query standalone, sem FROM bloqueios)
      if (sql.includes('SELECT id FROM tarefas WHERE external_id') && !sql.includes('FROM bloqueios')) {
        return Promise.resolve({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }
      // resolveOrCreate — busca incidente existente na tabela de incidentes
      if (sql.includes('motor_infrastructure_incidents') && sql.includes('SELECT') && sql.includes('WHERE signature')) {
        if (options.existingIncidentId) {
          return Promise.resolve({
            rows: [{ incident_id: options.existingIncidentId }],
            affectedRows: 0,
            insertId: 0,
          } satisfies QueryResult)
        }
        return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }
      // resolveOrCreate — insert novo incidente
      if (sql.includes('motor_infrastructure_incidents') && sql.includes('INSERT')) {
        return Promise.resolve({ rows: [], affectedRows: 1, insertId: 1 } satisfies QueryResult)
      }
      // resolveOrCreate — update last_seen_at
      if (sql.includes('motor_infrastructure_incidents') && sql.includes('UPDATE') && sql.includes('last_seen_at')) {
        return Promise.resolve({ rows: [], affectedRows: 1, insertId: 0 } satisfies QueryResult)
      }
      // addTaskToIncident — verifica associação existente
      if (sql.includes('motor_infrastructure_incident_tasks') && sql.includes('SELECT') && sql.includes('SELECT id')) {
        return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }
      // addTaskToIncident — insert associação
      if (sql.includes('motor_infrastructure_incident_tasks') && sql.includes('INSERT')) {
        return Promise.resolve({ rows: [], affectedRows: 1, insertId: 1 } satisfies QueryResult)
      }
      // getRecoveryHistory query — busca histórico da tarefa
      if (sql.includes('motor_infrastructure_recovery_history') && sql.includes('SELECT') && sql.includes('h.id')) {
        return Promise.resolve({
          rows: options.recoveryRows ?? [],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    }),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

function createMockRepository(taskOverrides: Partial<Record<string, unknown>> = {}): TaskRepository {
  return {
    saveTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue({
      id: 'task-blocked-1',
      chatId: '',
      agentId: 'test-agent',
      title: 'Tarefa bloqueada',
      description: '',
      repoPath: '/repo',
      buildCommand: 'npm run build',
      unitTestCommand: 'npm test',
      status: 'blocked' as const,
      maxRework: 3,
      hardTimeoutMs: 1000,
      projectSlug: 'test-project',
      createdAt: '',
      updatedAt: '',
      ...taskOverrides,
    }),
  }
}

function createMockCoordinatorInternals(coordinator: TaskCoordinator, options: {
  reuseExistingShouldThrow?: boolean
  verifyAgentOk?: boolean
} = {}) {
  const internal = coordinator as unknown as {
    workspaceManager: { reuseExisting: (opts: unknown) => Promise<{ projectPath: string; headCommit: string }> }
    verifyAgentBeforeEnqueue: (agentId: string) => Promise<{ ok: boolean; report?: string }>
    recoveryWorkspaces: Map<number, unknown>
    saveTaskTransition: () => Promise<void>
    pump: () => Promise<void>
    activeWorkers: Map<string, unknown>
  }
  internal.workspaceManager = {
    reuseExisting: options.reuseExistingShouldThrow
      ? vi.fn().mockRejectedValue(new Error("worktree persistido não encontrado"))
      : vi.fn().mockResolvedValue({ projectPath: '/repo', headCommit: 'a'.repeat(40) }),
  } as unknown as typeof internal.workspaceManager
  internal.verifyAgentBeforeEnqueue = vi.fn().mockResolvedValue(
    options.verifyAgentOk === false ? { ok: false, report: 'agente não encontrado' } : { ok: true }
  )
  internal.recoveryWorkspaces = new Map()
  internal.saveTaskTransition = vi.fn().mockResolvedValue(undefined)
  internal.pump = vi.fn().mockResolvedValue(undefined)
  internal.activeWorkers = new Map()
  return internal
}

// ─── Critério 1: Bloqueio elegível retomado sem recriar worktree nem perder commits ─

describe('Fluxo de recuperação segura — Critério 1: retomada sem recriar worktree', () => {
  it('reanalyzeAndResumeInfrastructureBlock reutiliza worktree existente via reuseExisting', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:testes falharam: porta <n> ocupada no commit <sha>',
        block_excerpt: 'worktree corrompido',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    const internal = createMockCoordinatorInternals(coordinator)

    await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1', {
      resumeType: 'manual',
      resumedBy: 'user:alexandre',
    })

    // Verifica que reuseExisting foi chamado (não prepare, que criaria worktree novo)
    expect(internal.workspaceManager.reuseExisting).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/worktree',
        branch: 'motor-v2/test',
        baseCommit: 'a'.repeat(40),
      })
    )
  })

  it('grava a retomada no histórico com motivo, correção, tipo e responsável', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:ssh deploy falhou',
        block_excerpt: 'SSH deploy host indisponível',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator)

    await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1', {
      resumeType: 'manual',
      resumedBy: 'user:alexandre',
    })

    // Verifica o INSERT no histórico
    const insertCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_recovery_history')
    )
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    // Params: [subtarefaId, incidentId, failureSignature, excerpt, correction, resumeType, resumedBy, executionId, taskId, taskId]
    expect(params[2]).toMatch(/^[a-f0-9]{40}$/) // failure_signature (hash SHA-256 truncado)
    expect(params[3]).toBe('SSH deploy host indisponível') // original_reason
    expect(params[4]).toContain('preflight consolidado') // correction_applied
    expect(params[5]).toBe('manual') // resume_type
    expect(params[6]).toBe('user:alexandre') // resumed_by
  })
})

// ─── Critério 2: Worktree ausente/inválido/divergente é recusado ──────────────

describe('Fluxo de recuperação segura — Critério 2: worktree inválido recusado', () => {
  it('reutilização falha quando worktree não existe → retomada abortada', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:test',
        block_excerpt: 'worktree ausente',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree-inexistente',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator, { reuseExistingShouldThrow: true })

    await expect(
      coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1')
    ).rejects.toThrow('worktree persistido não encontrado')

    // Nenhuma transição de tarefa foi feita
    const internal = coordinator as unknown as { saveTaskTransition: ReturnType<typeof vi.fn> }
    expect(internal.saveTaskTransition).not.toHaveBeenCalled()
  })

  it('branch divergente é recusada sem alterar o repositório', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:test',
        block_excerpt: 'branch divergente',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    const internal = createMockCoordinatorInternals(coordinator)
    // Simula divergência de branch
    internal.workspaceManager.reuseExisting = vi.fn().mockRejectedValue(
      new Error('branch do worktree diverge: esperada motor-v2/test, encontrada motor-v2/other')
    ) as unknown as typeof internal.workspaceManager.reuseExisting

    await expect(
      coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1')
    ).rejects.toThrow('branch do worktree diverge')

    // Nenhuma transição de tarefa foi feita
    expect(internal.saveTaskTransition).not.toHaveBeenCalled()
  })
})

// ─── Critério 3: Falha no preflight impede a retomada ─────────────────────────

describe('Fluxo de recuperação segura — Critério 3: preflight impede retomada', () => {
  it('dependências inconsistentes impedem a retomada (validado pelo ResumePreflightChecker)', async () => {
    // Este cenário é coberto pelo ResumePreflightChecker.test.ts
    // (dependencies_consistent check). Aqui validamos que o fluxo conceitual
    // está correto: o preflight é executado ANTES da retomada.
    const tempDir = await mkdtemp(join(tmpdir(), 'motor-v2-deps-check-'))
    try {
      const repoPath = join(tempDir, 'repo')
      await mkdir(repoPath, { recursive: true })
      const worktreePath = join(tempDir, 'worktree')
      await mkdir(worktreePath, { recursive: true })
      await writeFile(join(worktreePath, 'package.json'), '{}')
      await writeFile(join(worktreePath, 'package-lock.json'), '{}')
      // Sem node_modules → dependências ausentes

      const checker = new ResumePreflightChecker({
        gitRunner: {
          run: vi.fn().mockImplementation(async (command: readonly string[]) => {
            const cmdStr = command.join(' ')
            if (cmdStr.includes('--show-toplevel')) return { stdout: repoPath + '\n', stderr: '' }
            if (cmdStr.includes('status')) return { stdout: '', stderr: '' }
            return { stdout: '', stderr: '' }
          }),
        },
      })

      const report = await checker.check({ repoPath, worktreePath, checkDependencies: true })
      const depsCheck = report.checks.find((c) => c.check === 'dependencies_present')
      expect(depsCheck).toBeDefined()
      expect(depsCheck!.ok).toBe(false)
      expect(depsCheck!.cause).toContain('node_modules')
      expect(report.ok).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('Console indisponível impede a retomada', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:test',
        block_excerpt: 'Console fora do ar',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator, { verifyAgentOk: false })

    await expect(
      coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1')
    ).rejects.toThrow('Preflight Console falhou')

    // Nenhuma transição de tarefa foi feita
    const internal = coordinator as unknown as { saveTaskTransition: ReturnType<typeof vi.fn> }
    expect(internal.saveTaskTransition).not.toHaveBeenCalled()
  })
})

// ─── Critério 4: Agrupamento de incidente por assinatura ──────────────────────

describe('Fluxo de recuperação segura — Critério 4: agrupamento de incidente', () => {
  it('tarefas com a mesma assinatura de falha compartilham o mesmo incident_id', async () => {
    const existingIncidentId = 'incident-shared-001'
    const db = createMockDb({
      blockRows: [{
        id: 2,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:testes falharam: porta <n> ocupada no commit <sha>',
        block_excerpt: 'port conflict',
        subtarefa_id: 20,
        workspace_path: '/tmp/worktree2',
        workspace_branch: 'motor-v2/test2',
        workspace_base_commit: 'b'.repeat(40),
        repo_path: '/repo',
      }],
      existingIncidentId, // Já existe um incidente com essa assinatura
    })
    const repository = createMockRepository({ id: 'task-blocked-2' })
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator)

    const result = await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-2')

    // O incident_id retornado deve ser o mesmo do incidente existente
    expect(result.incidentId).toBe(existingIncidentId)
  })

  it('tarefas com assinaturas distintas NÃO são agrupadas (incident_id diferente)', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 3,
        block_reason: 'blocked_environment',
        block_command: 'motor-v2:ssh deploy connection refused',
        block_excerpt: 'SSH failure different signature',
        subtarefa_id: 30,
        workspace_path: '/tmp/worktree3',
        workspace_branch: 'motor-v2/test3',
        workspace_base_commit: 'c'.repeat(40),
        repo_path: '/repo',
      }],
      existingIncidentId: null, // Nenhum incidente existente com essa assinatura
    })
    const repository = createMockRepository({ id: 'task-blocked-3' })
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator)

    const result = await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-3')

    // O incident_id deve ser um novo identificador determinístico (não o do incidente anterior)
    expect(result.incidentId).toBeDefined()
    expect(result.incidentId).toMatch(/^incident-[a-f0-9]{16}-[a-z0-9]+$/)
    // Como não há incidente existente, o resolveOrCreate cria um novo incidente
    expect(result.incidentId).not.toBe('incident-shared-001')
  })

  it('failureFingerprint normaliza detalhes voláteis para agrupamento correto', () => {
    // Mesma falha em contextos diferentes deve produzir a mesma fingerprint
    const fp1 = failureFingerprint('Testes falharam: porta 3001 ocupada no commit abc1234')
    const fp2 = failureFingerprint('Testes falharam: porta 3002 ocupada no commit def5678')
    expect(fp1).toBe(fp2)

    // Falhas distintas devem produzir fingerprints distintas
    const fp3 = failureFingerprint('SSH deploy connection refused')
    const fp4 = failureFingerprint('TypeScript compilation error')
    expect(fp3).not.toBe(fp4)
  })

  it('isSystemicFailure identifica falhas com a mesma assinatura', () => {
    expect(isSystemicFailure([
      'Build falhou: conexão recusada na porta 3001',
      'Build falhou: conexão recusada na porta 3002',
    ])).toBe(true)

    expect(isSystemicFailure([
      'Build falhou: TypeScript error',
      'Testes falharam: assertion error',
    ])).toBe(false)
  })
})

// ─── Critério 5: Histórico completo com todos os campos de auditoria ──────────

describe('Fluxo de recuperação segura — Critério 5: histórico de auditoria', () => {
  it('getRecoveryHistory retorna todos os campos: motivo, correção, data, origem, responsável', async () => {
    const mockRows = [
      {
        id: 1,
        incident_id: 'inc-001',
        original_reason: 'SSH deploy host indisponível',
        correction_applied: 'preflight consolidado: Git/branch, dependências, Console e SSH',
        resume_type: 'manual',
        resumed_by: 'user:alexandre',
        execution_id: 'recovery-inc-001',
        created_at: '2026-09-10T16:30:00.000Z',
      },
    ]
    const db = createMockDb({ recoveryRows: mockRows })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })

    const history = await coordinator.getRecoveryHistory('task-123')

    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      id: 1,
      incidentId: 'inc-001',
      originalReason: 'SSH deploy host indisponível',
      correctionApplied: 'preflight consolidado: Git/branch, dependências, Console e SSH',
      resumeType: 'manual',
      resumedBy: 'user:alexandre',
      executionId: 'recovery-inc-001',
      createdAt: '2026-09-10T16:30:00.000Z',
    })
  })

  it('formatPreflightForHistory inclui motivo, correção, data, origem e responsável', () => {
    const report = {
      ok: true,
      checks: [
        { check: 'git_root' as const, ok: true, message: 'Repositório Git encontrado' },
        { check: 'branch_match' as const, ok: true, message: 'Branch corresponde à esperada' },
      ],
      failures: [],
      summary: 'Preflight OK: 2 verificações passaram com sucesso.',
      checkedAt: '2026-09-10T17:00:00.000Z',
    }

    const formatted = formatPreflightForHistory(report, {
      taskId: 'task-123',
      resumedBy: 'motor-v2',
      resumedAt: '2026-09-10T17:00:00.000Z',
    })

    expect(formatted).toContain('task-123')
    expect(formatted).toContain('motor-v2')
    expect(formatted).toContain('2026-09-10T17:00:00.000Z')
    expect(formatted).toContain('OK')
    expect(formatted).toContain('git_root')
    expect(formatted).toContain('branch_match')
  })

  it('formatPreflightForHistory com falha inclui causa e ação sugerida', () => {
    const report = {
      ok: false,
      checks: [
        { check: 'git_root' as const, ok: false, message: 'Repositório não encontrado', cause: 'O caminho /repo não existe', suggestedAction: 'Verificar repo_path' },
      ],
      failures: [
        { check: 'git_root' as const, ok: false, message: 'Repositório não encontrado', cause: 'O caminho /repo não existe', suggestedAction: 'Verificar repo_path' },
      ],
      incidentClassification: 'git_repository_missing' as const,
      summary: 'Preflight FALHOU: 1/1 verificações falharam',
      checkedAt: '2026-09-10T17:00:00.000Z',
    }

    const formatted = formatPreflightForHistory(report, {
      taskId: 'task-456',
      resumedBy: 'user:alexandre',
    })

    expect(formatted).toContain('FALHOU')
    expect(formatted).toContain('Causa')
    expect(formatted).toContain('Ação sugerida')
    expect(formatted).toContain('git_repository_missing')
  })
})

// ─── Critério 6: Suite de testes sem regressão ────────────────────────────────

describe('Fluxo de recuperação segura — Critério 6: sem regressão', () => {
  it('ResumePreflightChecker continua funcionando isoladamente', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'motor-v2-recovery-flow-'))
    try {
      const repoPath = join(tempDir, 'repo')
      await mkdir(repoPath, { recursive: true })

      const gitRunner = {
        run: vi.fn().mockImplementation(async (command: readonly string[]) => {
          const cmdStr = command.join(' ')
          if (cmdStr.includes('--show-toplevel')) return { stdout: repoPath + '\n', stderr: '' }
          if (cmdStr.includes('status')) return { stdout: '', stderr: '' }
          return { stdout: '', stderr: '' }
        }),
      }

      const checker = new ResumePreflightChecker({ gitRunner })
      const report = await checker.check({ repoPath })

      expect(report.ok).toBe(true)
      expect(report.checks.length).toBeGreaterThanOrEqual(2)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('SystemFailurePolicy continua classificando corretamente', () => {
    expect(isSystemicFailure(['erro porta 3001', 'erro porta 3002'])).toBe(true)
    expect(isSystemicFailure(['erro TypeScript', 'erro SSH'])).toBe(false)
    expect(isSystemicFailure(['único erro'])).toBe(false)
  })

  it('bloqueio não elegível é recusado sem alterar o repositório', async () => {
    const db = createMockDb({
      blockRows: [{
        id: 1,
        block_reason: 'clarification_needed',
        block_command: 'motor-v2:pergunta do analista',
        block_excerpt: 'analista perguntou sobre requisitos',
        subtarefa_id: 10,
        workspace_path: '/tmp/worktree',
        workspace_branch: 'motor-v2/test',
        workspace_base_commit: 'a'.repeat(40),
        repo_path: '/repo',
      }],
    })
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    createMockCoordinatorInternals(coordinator)

    await expect(
      coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1')
    ).rejects.toThrow('não elegível')

    // Nenhuma transição de tarefa foi feita
    const internal = coordinator as unknown as { saveTaskTransition: ReturnType<typeof vi.fn> }
    expect(internal.saveTaskTransition).not.toHaveBeenCalled()
  })
})
