/**
 * GatewayAgentVerificationPolicy — Verificação do agente no gateway antes de enfileirar
 *
 * Critérios de aceite:
 * - Tarefa de projeto novo só é enfileirada com agente confirmado no gateway
 * - Ausência do agente gera falha com causa clara
 * - Vitest cobre cenários agente presente, ausente e erro de consulta
 */

import { describe, it, expect } from 'vitest'
import {
  verifyAgentInGateway,
  formatAgentVerificationReport,
  shouldBlockEnqueue,
  type AgentLookupDriver,
} from '../src/policies/GatewayAgentVerificationPolicy.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockDriverWithAgents(agents: Array<{ id: string; workspace?: string }>): AgentLookupDriver {
  return {
    listAgents: async () => agents,
  }
}

function mockDriverWithError(error: Error): AgentLookupDriver {
  return {
    listAgents: async () => { throw error },
  }
}

// ─── verifyAgentInGateway ───────────────────────────────────────────────────

describe('verifyAgentInGateway', () => {
  describe('agente presente', () => {
    it('aprova quando o agente existe no gateway', async () => {
      const driver = mockDriverWithAgents([
        { id: 'programador-senior', workspace: '/data/workspace/projects/agentes/gerenteagentes' },
        { id: 'biblioteca-global', workspace: '/data/workspace/projects/agentes/bibliotecaglobal' },
      ])

      const result = await verifyAgentInGateway('programador-senior', driver)

      expect(result.ok).toBe(true)
      expect(result.agentId).toBe('programador-senior')
      expect(result.workspace).toBe('/data/workspace/projects/agentes/gerenteagentes')
      expect(result.failureKind).toBeUndefined()
    })

    it('aprova agente sem workspace (workspace é opcional)', async () => {
      const driver = mockDriverWithAgents([
        { id: 'taqui' },
      ])

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(true)
      expect(result.agentId).toBe('taqui')
      expect(result.workspace).toBeUndefined()
    })

    it('faz trim no agentId antes de comparar', async () => {
      const driver = mockDriverWithAgents([
        { id: 'taqui', workspace: '/workspace/taqui' },
      ])

      const result = await verifyAgentInGateway('  taqui  ', driver)

      expect(result.ok).toBe(true)
      expect(result.agentId).toBe('taqui')
    })
  })

  describe('agente ausente', () => {
    it('reprova quando o agente não existe no gateway', async () => {
      const driver = mockDriverWithAgents([
        { id: 'programador-senior' },
        { id: 'biblioteca-global' },
      ])

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.agentId).toBe('taqui')
      expect(result.failureKind).toBe('agent_not_found')
      expect(result.reason).toContain('taqui')
      expect(result.reason).toContain('não encontrado')
      expect(result.reason).toContain('programador-senior')
      expect(result.reason).toContain('biblioteca-global')
      expect(result.reason).toContain('openclaw agents add')
    })

    it('reprova com sugestão quando nenhum agente está registrado', async () => {
      const driver = mockDriverWithAgents([])

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('agent_not_found')
      expect(result.reason).toContain('Nenhum agente registrado')
    })

    it('reprova quando agentId é vazio', async () => {
      const driver = mockDriverWithAgents([
        { id: 'programador-senior' },
      ])

      const result = await verifyAgentInGateway('', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('agent_id_empty')
      expect(result.reason).toContain('vazio')
    })

    it('reprova quando agentId é nulo', async () => {
      const driver = mockDriverWithAgents([
        { id: 'programador-senior' },
      ])

      const result = await verifyAgentInGateway(null, driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('agent_id_empty')
      expect(result.reason).toContain('vazio')
    })

    it('reprova quando agentId é undefined', async () => {
      const driver = mockDriverWithAgents([])

      const result = await verifyAgentInGateway(undefined, driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('agent_id_empty')
    })

    it('reprova quando agentId é só espaços', async () => {
      const driver = mockDriverWithAgents([
        { id: 'programador-senior' },
      ])

      const result = await verifyAgentInGateway('   ', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('agent_id_empty')
    })
  })

  describe('erro de consulta ao gateway', () => {
    it('reprova com gateway_unreachable quando há erro de rede', async () => {
      const driver = mockDriverWithError(new Error('ECONNREFUSED: Connection refused'))

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('gateway_unreachable')
      expect(result.reason).toContain('inalcançável')
      expect(result.reason).toContain('taqui')
      expect(result.reason).toContain('ECONNREFUSED')
    })

    it('reprova com gateway_unreachable para timeout', async () => {
      const driver = mockDriverWithError(new Error('ETIMEDOUT: Connection timed out'))

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('gateway_unreachable')
      expect(result.reason).toContain('inalcançável')
    })

    it('reprova com gateway_error para erro HTTP', async () => {
      const driver = mockDriverWithError(new Error('HTTP 401 Unauthorized'))

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('gateway_error')
      expect(result.reason).toContain('Erro ao consultar gateway')
      expect(result.reason).toContain('OPENCLAW_CONSOLE')
    })

    it('reprova com gateway_error para erro genérico', async () => {
      const driver = mockDriverWithError(new Error('Something went wrong'))

      const result = await verifyAgentInGateway('taqui', driver)

      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('gateway_error')
      expect(result.reason).toContain('Erro ao consultar gateway')
    })
  })
})

// ─── formatAgentVerificationReport ──────────────────────────────────────────

describe('formatAgentVerificationReport', () => {
  it('formata relatório de sucesso com workspace', () => {
    const result = {
      ok: true as const,
      agentId: 'taqui',
      workspace: '/workspace/taqui',
    }
    const report = formatAgentVerificationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('taqui')
    expect(report).toContain('/workspace/taqui')
  })

  it('formata relatório de sucesso sem workspace', () => {
    const result = {
      ok: true as const,
      agentId: 'taqui',
    }
    const report = formatAgentVerificationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('taqui')
  })

  it('formata relatório de erro com failureKind', () => {
    const result = {
      ok: false as const,
      agentId: 'taqui',
      reason: 'Agente "taqui" não encontrado no gateway',
      failureKind: 'agent_not_found' as const,
    }
    const report = formatAgentVerificationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('[agent_not_found]')
    expect(report).toContain('taqui')
    expect(report).toContain('não encontrado')
  })

  it('formata relatório de erro sem failureKind', () => {
    const result = {
      ok: false as const,
      agentId: 'taqui',
      reason: 'Motivo qualquer',
    }
    const report = formatAgentVerificationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('Motivo qualquer')
  })
})

// ─── shouldBlockEnqueue ─────────────────────────────────────────────────────

describe('shouldBlockEnqueue', () => {
  it('bloqueia quando agente não encontrado', () => {
    const result = {
      ok: false as const,
      agentId: 'taqui',
      reason: 'não encontrado',
      failureKind: 'agent_not_found' as const,
    }
    expect(shouldBlockEnqueue(result)).toBe(true)
  })

  it('bloqueia quando gateway inalcançável', () => {
    const result = {
      ok: false as const,
      agentId: 'taqui',
      reason: 'inalcançável',
      failureKind: 'gateway_unreachable' as const,
    }
    expect(shouldBlockEnqueue(result)).toBe(true)
  })

  it('bloqueia quando agentId vazio', () => {
    const result = {
      ok: false as const,
      agentId: '',
      reason: 'vazio',
      failureKind: 'agent_id_empty' as const,
    }
    expect(shouldBlockEnqueue(result)).toBe(true)
  })

  it('não bloqueia quando agente confirmado', () => {
    const result = {
      ok: true as const,
      agentId: 'taqui',
    }
    expect(shouldBlockEnqueue(result)).toBe(false)
  })
})
