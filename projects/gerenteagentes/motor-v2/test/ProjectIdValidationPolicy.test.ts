/**
 * ProjectIdValidationPolicy — Validação de projeto_id na criação de tarefas
 * 
 * Critérios de aceite:
 * - projeto_id inválido rejeitado com erro claro na criação e na entrada do motor
 * - Tarefas de projeto novo devem referenciar a linha correta de projetos_captados
 *   (nunca a da biblioteca), rejeitando com erro claro
 * - Vitest cobre validação de projeto_id
 */

import { describe, it, expect } from 'vitest'
import {
  validateProjectId,
  validateProjectIdSync,
  formatProjectIdValidationReport,
} from '../src/policies/ProjectIdValidationPolicy.js'

// ─── validateProjectId (async) ──────────────────────────────────────────────

describe('validateProjectId', () => {
  const mockLookup = async (id: number) => {
    const projects: Record<number, {
      id: number
      slug: string
      agenteId: number | null
      agenteOpenclawId: string | null
      agenteNome: string | null
    }> = {
      1: { id: 1, slug: 'biblioteca-global', agenteId: 1, agenteOpenclawId: 'biblioteca-global', agenteNome: 'Biblioteca Global' },
      2: { id: 2, slug: 'taqui', agenteId: 2, agenteOpenclawId: 'taqui', agenteNome: 'TaQui' },
      3: { id: 3, slug: 'gerenteagentes', agenteId: 3, agenteOpenclawId: 'programador-senior', agenteNome: 'Gerente Agentes' },
      4: { id: 4, slug: 'projeto-sem-agente', agenteId: null, agenteOpenclawId: null, agenteNome: null },
    }
    return projects[id] ?? null
  }

  it('reprova projeto_id inexistente', async () => {
    const result = await validateProjectId(999, { taskType: 'execution' }, mockLookup)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('999')
    expect(result.reason).toContain('não encontrado')
  })

  it('reprova tarefa de execução apontando para biblioteca-global quando expectedSlug é diferente', async () => {
    const result = await validateProjectId(
      1, // biblioteca-global
      { taskType: 'execution', expectedSlug: 'taqui' },
      mockLookup,
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('biblioteca-global')
    expect(result.reason).toContain('taqui')
    expect(result.reason).toContain('projeto_id correto')
  })

  it('aprova tarefa de setup apontando para biblioteca-global', async () => {
    const result = await validateProjectId(
      1, // biblioteca-global
      { taskType: 'setup' },
      mockLookup,
    )
    expect(result.ok).toBe(true)
    expect(result.projectSlug).toBe('biblioteca-global')
  })

  it('aprova tarefa de execução apontando para projeto correto', async () => {
    const result = await validateProjectId(
      2, // taqui
      { taskType: 'execution', expectedSlug: 'taqui' },
      mockLookup,
    )
    expect(result.ok).toBe(true)
    expect(result.projectSlug).toBe('taqui')
    expect(result.agentId).toBe('taqui')
  })

  it('reprova projeto_id com slug diferente do expectedSlug', async () => {
    const result = await validateProjectId(
      2, // taqui
      { taskType: 'execution', expectedSlug: 'gerenteagentes' },
      mockLookup,
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('taqui')
    expect(result.reason).toContain('gerenteagentes')
    expect(result.reason).toContain('projeto_id incorreto')
  })

  it('reprova tarefa de execução para projeto sem agente vinculado', async () => {
    const result = await validateProjectId(
      4, // projeto-sem-agente
      { taskType: 'execution', expectedSlug: 'projeto-sem-agente' },
      mockLookup,
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('agente vinculado')
    expect(result.reason).toContain('agente_id nulo')
  })

  it('aprova tarefa de setup para projeto sem agente (setup é executado pela biblioteca)', async () => {
    const result = await validateProjectId(
      4, // projeto-sem-agente
      { taskType: 'setup', expectedSlug: 'projeto-sem-agente' },
      mockLookup,
    )
    expect(result.ok).toBe(true)
  })

  it('retorna agentId do openclaw_agent_id quando disponível', async () => {
    const result = await validateProjectId(
      3, // gerenteagentes
      { taskType: 'execution', expectedSlug: 'gerenteagentes' },
      mockLookup,
    )
    expect(result.ok).toBe(true)
    expect(result.agentId).toBe('programador-senior')
  })

  it('funciona sem expectedSlug (validação básica)', async () => {
    const result = await validateProjectId(
      2, // taqui
      { taskType: 'execution' },
      mockLookup,
    )
    expect(result.ok).toBe(true)
    expect(result.projectSlug).toBe('taqui')
  })
})

// ─── validateProjectIdSync ──────────────────────────────────────────────────

describe('validateProjectIdSync', () => {
  const knownProjectIds = [1, 2, 3]
  const bibliotecaProjectId = 1

  it('reprova projeto_id fora da lista de conhecidos', () => {
    const result = validateProjectIdSync(999, knownProjectIds, bibliotecaProjectId, { taskType: 'execution' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('999')
    expect(result.reason).toContain('não encontrado')
    expect(result.reason).toContain('1, 2, 3')
  })

  it('reprova tarefa de execução apontando para biblioteca quando expectedSlug é diferente', () => {
    const result = validateProjectIdSync(
      1, // biblioteca
      knownProjectIds,
      bibliotecaProjectId,
      { taskType: 'execution', expectedSlug: 'taqui' },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('biblioteca-global')
    expect(result.reason).toContain('taqui')
  })

  it('aprova projeto_id válido para tarefa de execução', () => {
    const result = validateProjectIdSync(
      2, // taqui
      knownProjectIds,
      bibliotecaProjectId,
      { taskType: 'execution', expectedSlug: 'taqui' },
    )
    expect(result.ok).toBe(true)
    expect(result.projetoCaptadoId).toBe(2)
  })

  it('aprova biblioteca para tarefa de setup', () => {
    const result = validateProjectIdSync(
      1, // biblioteca
      knownProjectIds,
      bibliotecaProjectId,
      { taskType: 'setup' },
    )
    expect(result.ok).toBe(true)
  })

  it('aprova sem expectedSlug (validação básica)', () => {
    const result = validateProjectIdSync(
      3,
      knownProjectIds,
      bibliotecaProjectId,
      { taskType: 'execution' },
    )
    expect(result.ok).toBe(true)
  })
})

// ─── formatProjectIdValidationReport ────────────────────────────────────────

describe('formatProjectIdValidationReport', () => {
  it('formata relatório de sucesso com slug e agente', () => {
    const result = {
      ok: true as const,
      projetoCaptadoId: 2,
      projectSlug: 'taqui',
      agentId: 'taqui',
    }
    const report = formatProjectIdValidationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('válido')
    expect(report).toContain('taqui')
  })

  it('formata relatório de sucesso sem agente', () => {
    const result = {
      ok: true as const,
      projetoCaptadoId: 2,
      projectSlug: 'taqui',
    }
    const report = formatProjectIdValidationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('taqui')
  })

  it('formata relatório de erro', () => {
    const result = {
      ok: false as const,
      reason: 'projeto_id=999 não encontrado em projetos_captados',
    }
    const report = formatProjectIdValidationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('inválido')
    expect(report).toContain('999')
    expect(report).toContain('não encontrado')
  })
})
