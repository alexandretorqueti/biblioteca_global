/**
 * PromotionValidationPolicy — Validação de promoção de subtarefas
 * 
 * Critérios de aceite:
 * - Subtarefa promovida com workspaceCommitSha nulo não pode fechar tarefa
 * - Tarefa com subtarefas sem commit permanece pendente/bloqueada com motivo auditável
 * - Vitest cobre promoção sem código
 */

import { describe, it, expect } from 'vitest'
import {
  validateSubtaskPromotion,
  validateTaskCompletion,
  formatPromotionValidationReport,
} from '../src/policies/PromotionValidationPolicy.js'
import {
  AGENT_RUN_FAILED_WITHOUT_REPLY,
  getAgentReplyFailureReason,
  isAgentRunFailureWithoutReply,
} from '../src/policies/NoReplyFailurePolicy.js'

describe('NoReplyFailurePolicy', () => {
  it('reconhece sentinel, resposta ausente, vazia ou malformada', () => {
    for (const content of [AGENT_RUN_FAILED_WITHOUT_REPLY, undefined, null, '', '   ', { unexpected: true }]) {
      expect(isAgentRunFailureWithoutReply(content)).toBe(true)
      expect(getAgentReplyFailureReason(content)).toBe(AGENT_RUN_FAILED_WITHOUT_REPLY)
    }
  })

  it('não rejeita uma resposta textual não vazia', () => {
    expect(isAgentRunFailureWithoutReply('Entrega concluída com evidências')).toBe(false)
    expect(getAgentReplyFailureReason('Entrega concluída com evidências')).toBeNull()
  })
})

// ─── validateSubtaskPromotion ───────────────────────────────────────────────

describe('validateSubtaskPromotion', () => {
  it('reprova subtarefa com workspaceCommitSha nulo', () => {
    const result = validateSubtaskPromotion({
      id: 1,
      workspaceCommitSha: null,
      workspaceStatus: 'approved',
      status: 'delivered',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('workspaceCommitSha')
    expect(result.reason).toContain('evidência de código ausente')
    expect(result.blockedAt).toBeDefined()
  })

  it('reprova subtarefa com workspaceCommitSha vazio', () => {
    const result = validateSubtaskPromotion({
      id: 2,
      workspaceCommitSha: '',
      workspaceStatus: 'approved',
      status: 'delivered',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('workspaceCommitSha')
  })

  it('reprova subtarefa com falha sem resposta mesmo com commit', () => {
    const result = validateSubtaskPromotion({
      id: 10, workspaceCommitSha: 'abc123', workspaceStatus: 'approved', status: 'delivered',
      resultado: '  The agent run failed before producing a reply.  ',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('sem resposta verificável')
  })

  it('reprova subtarefa com workspaceCommitSha apenas espaços', () => {
    const result = validateSubtaskPromotion({
      id: 3,
      workspaceCommitSha: '   ',
      workspaceStatus: 'approved',
      status: 'delivered',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('workspaceCommitSha')
  })

  it('reprova subtarefa com workspaceStatus integration_failed', () => {
    const result = validateSubtaskPromotion({
      id: 4,
      workspaceCommitSha: 'abc123',
      workspaceStatus: 'integration_failed',
      status: 'delivered',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('integration_failed')
    expect(result.reason).toContain('Integração falhou')
  })

  it('reprova promoção manual sem justificativa', () => {
    const result = validateSubtaskPromotion({
      id: 5,
      workspaceCommitSha: 'abc123',
      workspaceStatus: 'approved',
      status: 'delivered',
      promotionManual: true,
      promotionJustification: null,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('justificativa')
    expect(result.reason).toContain('motivo auditável')
  })

  it('reprova promoção manual com justificativa vazia', () => {
    const result = validateSubtaskPromotion({
      id: 6,
      workspaceCommitSha: 'abc123',
      workspaceStatus: 'approved',
      status: 'delivered',
      promotionManual: true,
      promotionJustification: '',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('justificativa')
  })

  it('aprova subtarefa com commit válido e workspace integrated', () => {
    const result = validateSubtaskPromotion({
      id: 7,
      workspaceCommitSha: 'abc123def456',
      workspaceStatus: 'integrated',
      status: 'delivered',
    })
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('aprova subtarefa com commit válido e workspace approved', () => {
    const result = validateSubtaskPromotion({
      id: 8,
      workspaceCommitSha: 'abc123def456',
      workspaceStatus: 'approved',
      status: 'delivered',
    })
    expect(result.ok).toBe(true)
  })

  it('aprova promoção manual com justificativa válida', () => {
    const result = validateSubtaskPromotion({
      id: 9,
      workspaceCommitSha: 'abc123',
      workspaceStatus: 'approved',
      status: 'delivered',
      promotionManual: true,
      promotionJustification: 'Merge manual após revisão do time',
    })
    expect(result.ok).toBe(true)
  })
})

// ─── validateTaskCompletion ─────────────────────────────────────────────────

describe('validateTaskCompletion', () => {
  it('reprova tarefa com subtarefas sem workspaceCommitSha', () => {
    const subtasks = [
      { id: 1, seq: 1, workspaceCommitSha: 'abc123', status: 'verified' },
      { id: 2, seq: 2, workspaceCommitSha: null, status: 'verified' },
      { id: 3, seq: 3, workspaceCommitSha: 'def456', status: 'verified' },
    ]
    const result = validateTaskCompletion(subtasks)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('1 subtarefa(s)')
    expect(result.reason).toContain('#2')
    expect(result.reason).toContain('id=2')
    expect(result.reason).toContain('Promoção manual sem código')
  })

  it('reprova tarefa com múltiplas subtarefas sem commit', () => {
    const subtasks = [
      { id: 1, seq: 1, workspaceCommitSha: null, status: 'verified' },
      { id: 2, seq: 2, workspaceCommitSha: null, status: 'verified' },
      { id: 3, seq: 3, workspaceCommitSha: 'abc123', status: 'verified' },
    ]
    const result = validateTaskCompletion(subtasks)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('2 subtarefa(s)')
    expect(result.reason).toContain('#1')
    expect(result.reason).toContain('#2')
  })

  it('aprova tarefa com todas as subtarefas com commit válido', () => {
    const subtasks = [
      { id: 1, seq: 1, workspaceCommitSha: 'abc123', status: 'verified' },
      { id: 2, seq: 2, workspaceCommitSha: 'def456', status: 'verified' },
      { id: 3, seq: 3, workspaceCommitSha: 'ghi789', status: 'verified' },
    ]
    const result = validateTaskCompletion(subtasks)
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('reprova tarefa com subtarefa com commit vazio', () => {
    const subtasks = [
      { id: 1, seq: 1, workspaceCommitSha: 'abc123', status: 'verified' },
      { id: 2, seq: 2, workspaceCommitSha: '', status: 'verified' },
    ]
    const result = validateTaskCompletion(subtasks)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('1 subtarefa(s)')
  })

  it('reprova tarefa com subtarefa verificada por falha sem resposta', () => {
    const result = validateTaskCompletion([
      { id: 1, seq: 1, workspaceCommitSha: 'abc123', status: 'verified', resultado: AGENT_RUN_FAILED_WITHOUT_REPLY },
    ])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('evidência válida')
  })

  it('aprova tarefa vazia (sem subtarefas)', () => {
    const result = validateTaskCompletion([])
    expect(result.ok).toBe(true)
  })
})

// ─── formatPromotionValidationReport ────────────────────────────────────────

describe('formatPromotionValidationReport', () => {
  it('formata relatório de sucesso', () => {
    const result = { ok: true as const }
    const report = formatPromotionValidationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('OK')
  })

  it('formata relatório de bloqueio', () => {
    const result = {
      ok: false as const,
      reason: 'Subtarefa #1 promovida sem workspaceCommitSha',
      blockedAt: '2026-09-03T15:00:00.000Z',
    }
    const report = formatPromotionValidationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('BLOQUEADA')
    expect(report).toContain('Motivo')
    expect(report).toContain('workspaceCommitSha')
    expect(report).toContain('Bloqueado em')
    expect(report).toContain('2026-09-03')
  })

  it('formata relatório sem blockedAt', () => {
    const result = {
      ok: false as const,
      reason: 'Teste de bloqueio',
    }
    const report = formatPromotionValidationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('Motivo')
    expect(report).not.toContain('Bloqueado em')
  })
})
