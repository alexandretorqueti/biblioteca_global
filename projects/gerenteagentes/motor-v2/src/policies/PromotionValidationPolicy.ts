/**
 * PromotionValidationPolicy - Validação de promoção de subtarefas
 * 
 * Regra: subtarefa promovida manualmente com workspaceCommitSha nulo não pode
 * resultar em tarefa completed — permanece pendente/bloqueada com motivo auditável.
 * 
 * Motivo: no TaQui, subtarefas foram promovidas manualmente sem evidência de código,
 * e a tarefa pai fechou como concluída sem trabalho real entregue.
 */

import { isAgentRunFailureWithoutReply } from './NoReplyFailurePolicy.js'

export interface PromotionValidationResult {
  ok: boolean
  reason?: string
  blockedAt?: string
}

/**
 * Valida se uma subtarefa pode ser promovida para verified/completed.
 * 
 * Critérios:
 * - workspaceCommitSha não pode ser nulo/vazio (evidência de código)
 * - workspaceStatus deve ser 'integrated' ou 'approved' (não 'integration_failed')
 * - Se promotionManual=true, exige justificativa registrada
 * 
 * @param subtask - Dados da subtarefa a validar
 * @returns Resultado da validação com motivo se bloqueada
 */
export function validateSubtaskPromotion(subtask: {
  id: number
  workspaceCommitSha: string | null
  workspaceStatus: string | null
  status: string
  promotionManual?: boolean
  promotionJustification?: string | null
  resultado?: string | null
}): PromotionValidationResult {
  // Um runtime pode finalizar sem produzir resposta. Isso não é evidência de
  // entrega e não pode ser promovido, mesmo que exista um commit associado.
  if (subtask.resultado !== undefined && isAgentRunFailureWithoutReply(subtask.resultado)) {
    return {
      ok: false,
      reason: `Subtarefa #${subtask.id} sem resposta verificável do agente. Falha de execução não pode ser promovida para verified.`,
      blockedAt: new Date().toISOString(),
    }
  }

  // Regra 1: workspaceCommitSha é obrigatório
  if (!subtask.workspaceCommitSha || subtask.workspaceCommitSha.trim() === '') {
    return {
      ok: false,
      reason: `Subtarefa #${subtask.id} promovida sem workspaceCommitSha (evidência de código ausente). ` +
              `Promoção manual sem código não pode fechar tarefa.`,
      blockedAt: new Date().toISOString(),
    }
  }

  // Regra 2: workspaceStatus não pode ser 'integration_failed'
  if (subtask.workspaceStatus === 'integration_failed') {
    return {
      ok: false,
      reason: `Subtarefa #${subtask.id} com workspaceStatus='integration_failed' não pode ser promovida. ` +
              `Integração falhou — revise o merge ou use recover.`,
      blockedAt: new Date().toISOString(),
    }
  }

  // Regra 3: promoção manual exige justificativa
  if (subtask.promotionManual && (!subtask.promotionJustification || subtask.promotionJustification.trim() === '')) {
    return {
      ok: false,
      reason: `Subtarefa #${subtask.id} promovida manualmente sem justificativa registrada. ` +
              `Promoção manual exige motivo auditável.`,
      blockedAt: new Date().toISOString(),
    }
  }

  return { ok: true }
}

/**
 * Valida se todas as subtarefas de uma tarefa podem ser marcadas como completed.
 * 
 * Regra: se qualquer subtarefa tem workspaceCommitSha nulo, a tarefa pai não pode
 * ser marcada como completed — permanece pending/blocked.
 * 
 * @param subtasks - Lista de subtarefas da tarefa
 * @returns Resultado da validação com lista de subtarefas problemáticas
 */
export function validateTaskCompletion(subtasks: Array<{
  id: number
  seq: number
  workspaceCommitSha: string | null
  status: string
  resultado?: string | null
}>): PromotionValidationResult {
  const invalidSubtasks = subtasks.filter(
    (st) => !st.workspaceCommitSha || st.workspaceCommitSha.trim() === '' ||
      (st.resultado !== undefined && isAgentRunFailureWithoutReply(st.resultado))
  )

  if (invalidSubtasks.length > 0) {
    const ids = invalidSubtasks.map((st) => `#${st.seq} (id=${st.id})`).join(', ')
    return {
      ok: false,
      reason: `Tarefa não pode ser concluída: ${invalidSubtasks.length} subtarefa(s) sem evidência válida: ${ids}. ` +
              `Promoção manual sem código ou resposta do agente não fecha tarefa.`,
      blockedAt: new Date().toISOString(),
    }
  }

  return { ok: true }
}

/**
 * Formata relatório de validação de promoção para log/auditoria.
 */
export function formatPromotionValidationReport(result: PromotionValidationResult): string {
  if (result.ok) {
    return '✅ Validação de promoção: OK'
  }

  const lines = [
    '❌ Validação de promoção: BLOQUEADA',
    '',
    `Motivo: ${result.reason}`,
  ]

  if (result.blockedAt) {
    lines.push(`Bloqueado em: ${result.blockedAt}`)
  }

  return lines.join('\n')
}
