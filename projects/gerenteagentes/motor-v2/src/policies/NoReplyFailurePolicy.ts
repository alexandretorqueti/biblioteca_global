/** Falha do runtime que não representa uma resposta/entrega do agente. */
export const AGENT_RUN_FAILED_WITHOUT_REPLY = "The agent run failed before producing a reply."

export function isAgentRunFailureWithoutReply(content: string | null | undefined): boolean {
  return content?.trim() === AGENT_RUN_FAILED_WITHOUT_REPLY
}
