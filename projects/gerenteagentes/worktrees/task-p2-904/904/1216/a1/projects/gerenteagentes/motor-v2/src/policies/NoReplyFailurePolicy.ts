/** Falha do runtime que não representa uma resposta/entrega do agente. */
export const AGENT_RUN_FAILED_WITHOUT_REPLY = "The agent run failed before producing a reply."

/**
 * Retorna um motivo canônico quando o runtime não produziu uma entrega válida.
 *
 * O gateway pode reportar `state=final` sem conteúdo ou com o sentinel de
 * falha. Ambos são resultados não verificáveis e não podem atravessar o gate
 * de promoção. Valores não-string também são tratados como ausência, para
 * proteger o motor contra respostas malformadas do driver.
 */
export function getAgentReplyFailureReason(content: unknown): string | null {
  if (typeof content !== "string") return AGENT_RUN_FAILED_WITHOUT_REPLY

  const trimmed = content.trim()
  if (!trimmed || trimmed === AGENT_RUN_FAILED_WITHOUT_REPLY) {
    return AGENT_RUN_FAILED_WITHOUT_REPLY
  }

  return null
}

export function isAgentRunFailureWithoutReply(content: unknown): boolean {
  return getAgentReplyFailureReason(content) !== null
}
