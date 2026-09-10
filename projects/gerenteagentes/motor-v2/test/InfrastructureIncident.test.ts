/**
 * Testes do InfrastructureIncident — agrupamento determinístico de falhas.
 * @vitest-environment node
 *
 * Valida os critérios da subtarefa 4:
 * 1. A assinatura é determinística: mesmos componentes → mesma assinatura
 * 2. Assinaturas distintas NÃO são agrupadas
 * 3. A normalização remove detalhes voláteis (SHAs, portas, caminhos)
 * 4. O incidente é criado/atualizado com janela temporal correta
 * 5. Tarefas associadas ao incidente são registradas sem duplicação
 */

import { describe, it, expect, vi } from 'vitest'
import type { Db, QueryResult } from '../src/shared/types/infrastructure.js'
import {
  computeIncidentSignature,
  buildSignatureComponents,
  normalizeIncidentMessage,
  affectedServiceFromClassification,
  InfrastructureIncidentManager,
  type IncidentFailureClass,
  type IncidentAffectedService,
} from '../src/policies/InfrastructureIncident.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockDb(options: {
  existingIncident?: { incident_id: string; signature: string } | null
  existingTaskAssociations?: Array<{ incident_id: string; tarefa_id: number }>
  incidentDetails?: Record<string, unknown> | null
  incidentTasks?: Array<{ tarefa_id: number }>
} = {}): Db {
  const db: Db = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      // getIncident — detalhes do incidente (query com WHERE incident_id = ?, sem signature na busca)
      // Deve vir ANTES do resolveOrCreate porque ambos incluem 'signature' no SELECT
      if (sql.includes('FROM motor_infrastructure_incidents') && sql.includes('WHERE incident_id') && !sql.includes('incident_tasks')) {
        if (options.incidentDetails) {
          return Promise.resolve({
            rows: [options.incidentDetails],
            affectedRows: 0,
            insertId: 0,
          } satisfies QueryResult)
        }
        return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }
      // resolveOrCreate — busca incidente existente (WHERE signature = ?)
      if (sql.includes('motor_infrastructure_incidents') && sql.includes('SELECT') && sql.includes('signature') && sql.includes('WHERE signature')) {
        if (options.existingIncident) {
          return Promise.resolve({
            rows: [options.existingIncident],
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
      // addTaskToIncident — verifica associação existente (SELECT id, não SELECT tarefa_id)
      if (sql.includes('motor_infrastructure_incident_tasks') && sql.includes('SELECT') && sql.includes('SELECT id') && sql.includes('incident_id') && sql.includes('tarefa_id')) {
        const incidentId = params?.[0] as string
        const tarefaId = params?.[1] as number
        const existing = (options.existingTaskAssociations ?? []).filter(
          (a) => a.incident_id === incidentId && a.tarefa_id === tarefaId,
        )
        return Promise.resolve({
          rows: existing.map((a) => ({ id: 1 })),
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      // addTaskToIncident — insert associação
      if (sql.includes('motor_infrastructure_incident_tasks') && sql.includes('INSERT')) {
        return Promise.resolve({ rows: [], affectedRows: 1, insertId: 1 } satisfies QueryResult)
      }
      // getIncident — tarefas associadas
      if (sql.includes('motor_infrastructure_incident_tasks') && sql.includes('SELECT') && sql.includes('tarefa_id')) {
        return Promise.resolve({
          rows: options.incidentTasks ?? [],
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

// ─── Critério 1: Assinatura determinística ────────────────────────────────────

describe('InfrastructureIncident — Critério 1: assinatura determinística', () => {
  it('mesmos componentes produzem a mesma assinatura', () => {
    const components = {
      failureClass: 'ssh_deploy_unreachable' as IncidentFailureClass,
      affectedService: 'ssh_deploy' as IncidentAffectedService,
      normalizedMessage: 'connection refused on deploy host',
    }
    const sig1 = computeIncidentSignature(components)
    const sig2 = computeIncidentSignature(components)
    expect(sig1).toBe(sig2)
    expect(sig1).toMatch(/^[a-f0-9]{40}$/)
  })

  it('assinatura é um hash SHA-256 truncado (40 chars hex)', () => {
    const components = buildSignatureComponents('console_unreachable', 'Console fora do ar')
    const sig = computeIncidentSignature(components)
    expect(sig).toHaveLength(40)
    expect(sig).toMatch(/^[a-f0-9]{40}$/)
  })

  it('ordem dos componentes importa (canonical ordering)', () => {
    const sig1 = computeIncidentSignature({
      failureClass: 'ssh_deploy_unreachable',
      affectedService: 'ssh_deploy',
      normalizedMessage: 'erro A',
    })
    const sig2 = computeIncidentSignature({
      failureClass: 'console_unreachable',
      affectedService: 'ssh_deploy',
      normalizedMessage: 'erro A',
    })
    expect(sig1).not.toBe(sig2)
  })
})

// ─── Critério 2: Assinaturas distintas NÃO são agrupadas ─────────────────────

describe('InfrastructureIncident — Critério 2: assinaturas distintas não agrupadas', () => {
  it('classes de falha diferentes produzem assinaturas diferentes', () => {
    const sig1 = computeIncidentSignature(buildSignatureComponents('ssh_deploy_unreachable', 'connection refused'))
    const sig2 = computeIncidentSignature(buildSignatureComponents('console_unreachable', 'connection refused'))
    expect(sig1).not.toBe(sig2)
  })

  it('serviços afetados diferentes produzem assinaturas diferentes', () => {
    const sig1 = computeIncidentSignature({
      failureClass: 'multiple_infrastructure_failures',
      affectedService: 'ssh_deploy',
      normalizedMessage: 'erro',
    })
    const sig2 = computeIncidentSignature({
      failureClass: 'multiple_infrastructure_failures',
      affectedService: 'console',
      normalizedMessage: 'erro',
    })
    expect(sig1).not.toBe(sig2)
  })

  it('mensagens normalizadas diferentes produzem assinaturas diferentes', () => {
    const sig1 = computeIncidentSignature(buildSignatureComponents('ssh_deploy_unreachable', 'SSH connection refused'))
    const sig2 = computeIncidentSignature(buildSignatureComponents('ssh_deploy_unreachable', 'SSH permission denied'))
    expect(sig1).not.toBe(sig2)
  })
})

// ─── Critério 3: Normalização remove detalhes voláteis ───────────────────────

describe('InfrastructureIncident — Critério 3: normalização de mensagem', () => {
  it('remove SHAs de commit', () => {
    const normalized = normalizeIncidentMessage('Build falhou no commit abc1234def5678')
    expect(normalized).not.toContain('abc1234def5678')
    expect(normalized).toContain('<sha>')
  })

  it('remove números de porta', () => {
    const normalized = normalizeIncidentMessage('Porta 3001 ocupada no host 192.168.1.8')
    expect(normalized).not.toContain('3001')
    expect(normalized).toContain('<n>')
  })

  it('remove caminhos absolutos', () => {
    const normalized = normalizeIncidentMessage('Falha em /data/workspace/projects/gerenteagentes/worktrees/task-1')
    expect(normalized).not.toContain('/data/workspace')
    expect(normalized).toContain('<path>')
  })

  it('remove timestamps ISO', () => {
    const normalized = normalizeIncidentMessage('Erro em 2026-09-10T18:00:00.000Z')
    expect(normalized).not.toContain('2026-09-10')
    expect(normalized).toContain('<timestamp>')
  })

  it('remove UUIDs', () => {
    const normalized = normalizeIncidentMessage('Incident 550e8400-e29b-41d4-a716-446655440000 falhou')
    expect(normalized).not.toContain('550e8400')
    expect(normalized).toContain('<uuid>')
  })

  it('remove endereços IP', () => {
    const normalized = normalizeIncidentMessage('Host 192.168.1.8 indisponível')
    expect(normalized).not.toContain('192.168.1.8')
    expect(normalized).toContain('<addr>')
  })

  it('mensagens com detalhes voláteis diferentes produzem a mesma assinatura', () => {
    const msg1 = 'Porta 3001 ocupada no commit abc1234 em /tmp/worktree-1'
    const msg2 = 'Porta 3002 ocupada no commit def5678 em /tmp/worktree-2'
    const sig1 = computeIncidentSignature(buildSignatureComponents('dependencies_missing', msg1))
    const sig2 = computeIncidentSignature(buildSignatureComponents('dependencies_missing', msg2))
    expect(sig1).toBe(sig2)
  })

  it('trunca mensagem normalizada em 300 caracteres', () => {
    const longMessage = 'x'.repeat(500)
    const normalized = normalizeIncidentMessage(longMessage)
    expect(normalized.length).toBeLessThanOrEqual(300)
  })
})

// ─── Mapeamento: classe → serviço afetado ────────────────────────────────────

describe('InfrastructureIncident — mapeamento classe → serviço', () => {
  it('git_repository_missing → git', () => {
    expect(affectedServiceFromClassification('git_repository_missing')).toBe('git')
  })

  it('git_repository_corrupted → git', () => {
    expect(affectedServiceFromClassification('git_repository_corrupted')).toBe('git')
  })

  it('worktree_missing → worktree', () => {
    expect(affectedServiceFromClassification('worktree_missing')).toBe('worktree')
  })

  it('branch_diverged → worktree', () => {
    expect(affectedServiceFromClassification('branch_diverged')).toBe('worktree')
  })

  it('commit_lost → worktree', () => {
    expect(affectedServiceFromClassification('commit_lost')).toBe('worktree')
  })

  it('dependencies_missing → dependencies', () => {
    expect(affectedServiceFromClassification('dependencies_missing')).toBe('dependencies')
  })

  it('dependencies_inconsistent → dependencies', () => {
    expect(affectedServiceFromClassification('dependencies_inconsistent')).toBe('dependencies')
  })

  it('console_unreachable → console', () => {
    expect(affectedServiceFromClassification('console_unreachable')).toBe('console')
  })

  it('ssh_deploy_unreachable → ssh_deploy', () => {
    expect(affectedServiceFromClassification('ssh_deploy_unreachable')).toBe('ssh_deploy')
  })

  it('project_scope_violation → project_scope', () => {
    expect(affectedServiceFromClassification('project_scope_violation')).toBe('project_scope')
  })

  it('multiple_infrastructure_failures → multiple', () => {
    expect(affectedServiceFromClassification('multiple_infrastructure_failures')).toBe('multiple')
  })
})

// ─── Critério 4: Incidente criado/atualizado com janela temporal ─────────────

describe('InfrastructureIncident — Critério 4: janela temporal do incidente', () => {
  it('resolveOrCreate cria novo incidente quando não existe nenhum', async () => {
    const db = createMockDb({ existingIncident: null })
    const manager = new InfrastructureIncidentManager({ db })
    const signature = computeIncidentSignature(
      buildSignatureComponents('ssh_deploy_unreachable', 'connection refused'),
    )

    const incidentId = await manager.resolveOrCreate(
      signature,
      'ssh_deploy_unreachable',
      'ssh_deploy',
      'connection refused',
    )

    expect(incidentId).toBeDefined()
    expect(incidentId).toMatch(/^incident-[a-f0-9]{16}-/)

    // Verifica que o INSERT foi chamado
    const insertCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_incidents'),
    )
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    expect(params[0]).toBe(incidentId) // incident_id
    expect(params[1]).toBe(signature) // signature
    expect(params[2]).toBe('ssh_deploy_unreachable') // failure_class
    expect(params[3]).toBe('ssh_deploy') // affected_service
  })

  it('resolveOrCreate reutiliza incidente existente dentro da janela', async () => {
    const existingId = 'incident-abc1234567890abc-1234'
    const signature = 'a'.repeat(40)
    const db = createMockDb({
      existingIncident: { incident_id: existingId, signature },
    })
    const manager = new InfrastructureIncidentManager({ db })

    const incidentId = await manager.resolveOrCreate(
      signature,
      'console_unreachable',
      'console',
      'console unreachable',
    )

    expect(incidentId).toBe(existingId)

    // Verifica que o UPDATE do last_seen_at foi chamado
    const updateCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('UPDATE motor_infrastructure_incidents') && call[0].includes('last_seen_at'),
    )
    expect(updateCall).toBeDefined()
  })

  it('janela temporal padrão é 7 dias', async () => {
    const db = createMockDb({ existingIncident: null })
    const manager = new InfrastructureIncidentManager({ db })
    const signature = computeIncidentSignature(
      buildSignatureComponents('git_repository_missing', 'repo not found'),
    )

    await manager.resolveOrCreate(signature, 'git_repository_missing', 'git', 'repo not found')

    // Verifica que a query de busca usa INTERVAL 7 dias (604800 segundos)
    const selectCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('motor_infrastructure_incidents') && call[0].includes('SELECT') && call[0].includes('signature'),
    )
    expect(selectCall).toBeDefined()
    const params = selectCall![1] as unknown[]
    expect(params[1]).toBe(604800) // 7 * 24 * 60 * 60
  })
})

// ─── Critério 5: Tarefas associadas sem duplicação ───────────────────────────

describe('InfrastructureIncident — Critério 5: tarefas associadas ao incidente', () => {
  it('addTaskToIncident associa tarefa ao incidente', async () => {
    const db = createMockDb({ existingTaskAssociations: [] })
    const manager = new InfrastructureIncidentManager({ db })

    await manager.addTaskToIncident('incident-001', 42)

    const insertCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_incident_tasks'),
    )
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    expect(params[0]).toBe('incident-001')
    expect(params[1]).toBe(42)
  })

  it('addTaskToIncident é idempotente (não duplica associação)', async () => {
    const db = createMockDb({
      existingTaskAssociations: [{ incident_id: 'incident-001', tarefa_id: 42 }],
    })
    const manager = new InfrastructureIncidentManager({ db })

    await manager.addTaskToIncident('incident-001', 42)

    // Não deve ter chamado INSERT (associação já existe)
    const insertCall = vi.mocked(db.query).mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_incident_tasks'),
    )
    expect(insertCall).toBeUndefined()
  })

  it('getIncident retorna detalhes com tarefas associadas', async () => {
    const db = createMockDb({
      incidentDetails: {
        incident_id: 'incident-001',
        signature: 'a'.repeat(40),
        failure_class: 'ssh_deploy_unreachable',
        affected_service: 'ssh_deploy',
        normalized_message: 'connection refused',
        first_seen_at: '2026-09-10T10:00:00.000Z',
        last_seen_at: '2026-09-10T18:00:00.000Z',
        created_at: '2026-09-10T10:00:00.000Z',
        updated_at: '2026-09-10T18:00:00.000Z',
      },
      incidentTasks: [{ tarefa_id: 42 }, { tarefa_id: 43 }],
    })
    const manager = new InfrastructureIncidentManager({ db })

    const incident = await manager.getIncident('incident-001')

    expect(incident).not.toBeNull()
    expect(incident!.incidentId).toBe('incident-001')
    expect(incident!.signature).toBe('a'.repeat(40))
    expect(incident!.firstSeenAt).toBe('2026-09-10T10:00:00.000Z')
    expect(incident!.lastSeenAt).toBe('2026-09-10T18:00:00.000Z')
    expect(incident!.affectedTaskIds).toEqual([42, 43])
  })

  it('getIncident retorna null para incidente inexistente', async () => {
    const db = createMockDb({ incidentDetails: null })
    const manager = new InfrastructureIncidentManager({ db })

    const incident = await manager.getIncident('incident-nonexistent')

    expect(incident).toBeNull()
  })
})

// ─── buildSignatureComponents ────────────────────────────────────────────────

describe('InfrastructureIncident — buildSignatureComponents', () => {
  it('deriva affectedService da failureClass automaticamente', () => {
    const components = buildSignatureComponents('console_unreachable', 'Console fora do ar')
    expect(components.failureClass).toBe('console_unreachable')
    expect(components.affectedService).toBe('console')
    expect(components.normalizedMessage).toBeTruthy()
  })

  it('normaliza a mensagem de entrada', () => {
    const components = buildSignatureComponents(
      'ssh_deploy_unreachable',
      'SSH deploy falhou no commit abc1234 para alexandre@192.168.1.8',
    )
    expect(components.normalizedMessage).not.toContain('abc1234')
    expect(components.normalizedMessage).not.toContain('192.168.1.8')
    expect(components.normalizedMessage).toContain('<sha>')
    expect(components.normalizedMessage).toContain('<addr>')
  })
})
