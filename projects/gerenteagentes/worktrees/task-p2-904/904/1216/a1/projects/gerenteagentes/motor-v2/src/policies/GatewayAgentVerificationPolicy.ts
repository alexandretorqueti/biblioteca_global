/**
 * GatewayAgentVerificationPolicy — Verificação do agente no gateway antes de enfileirar
 *
 * Regra: antes de enfileirar tarefa de projeto novo, o motor verifica a existência
 * do agente no gateway (via Console API). Ausente => falha com causa clara e
 * auditável (nunca "Unknown agent id" sem diagnóstico).
 *
 * Motivação (TaQui, 2026-09-03): o motor enfileirava tarefas para agentes que
 * nunca foram registrados no gateway, resultando em "Unknown agent id" sem
 * diagnóstico útil. O princípio diretivo é: prompt orienta, código obriga.
 *
 * Princípio diretivo (Alexandre 2026-09-03):
 * > Sempre que houver decisão ou proibição, ela deve ser CONTROLADA PELO MOTOR
 * > (código/gate), não apenas escrita no prompt do agente.
 */

/**
 * Resultado da verificação do agente no gateway.
 */
export interface AgentVerificationResult {
  /** true se o agente existe e está acessível no gateway */
  ok: boolean
  /** Motivo da falha (quando ok=false). Sempre presente quando ok=false. */
  reason?: string
  /** ID do agente verificado */
  agentId: string
  /** Workspace do agente no gateway (quando encontrado) */
  workspace?: string
  /** Tipo de falha para classificação programática */
  failureKind?: 'agent_not_found' | 'gateway_unreachable' | 'gateway_error' | 'agent_id_empty'
}

/**
 * Interface mínima do driver do Console necessária para a verificação.
 * Permite injeção de mock nos testes.
 */
export interface AgentLookupDriver {
  /**
   * Busca agentes registrados no gateway.
   * Retorna lista de { id, workspace? } ou lança erro em caso de falha.
   */
  listAgents(): Promise<Array<{ id: string; workspace?: string }>>
}

/**
 * Verifica se o agente existe no gateway antes de enfileirar a tarefa.
 *
 * Regras:
 * - agentId vazio/nulo => falha imediata com causa clara
 * - Gateway inalcançável (erro de rede) => falha com kind='gateway_unreachable'
 * - Gateway retorna erro HTTP => falha com kind='gateway_error'
 * - Agente não encontrado na lista => falha com kind='agent_not_found'
 * - Agente encontrado => ok=true com workspace (quando disponível)
 *
 * @param agentId - ID do agente a verificar (openclaw_agent_id)
 * @param driver - Driver do Console (injetável para testes)
 * @returns Resultado da verificação com diagnóstico completo
 */
export async function verifyAgentInGateway(
  agentId: string | null | undefined,
  driver: AgentLookupDriver,
): Promise<AgentVerificationResult> {
  // Regra 1: agentId não pode ser vazio
  if (!agentId || typeof agentId !== 'string' || agentId.trim().length === 0) {
    return {
      ok: false,
      agentId: agentId ?? '',
      reason: 'agentId vazio ou nulo: tarefa sem agente configurado. ' +
              'Verifique se o projeto tem agente vinculado em projetos_captados.',
      failureKind: 'agent_id_empty',
    }
  }

  const trimmedId = agentId.trim()

  // Regra 2: buscar agentes no gateway
  let agents: Array<{ id: string; workspace?: string }>
  try {
    agents = await driver.listAgents()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Distingue erro de rede de erro HTTP
    const isNetworkError = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|FETCH_FAILED|network|timeout/i.test(message)
    return {
      ok: false,
      agentId: trimmedId,
      reason: isNetworkError
        ? `Gateway OpenClaw inalcançável ao verificar agente "${trimmedId}": ${message}. ` +
          `Verifique se o Console está rodando e acessível.`
        : `Erro ao consultar gateway OpenClaw para agente "${trimmedId}": ${message}. ` +
          `Verifique a configuração do Console (OPENCLAW_CONSOLE_URL, OPENCLAW_CONSOLE_TOKEN).`,
      failureKind: isNetworkError ? 'gateway_unreachable' : 'gateway_error',
    }
  }

  // Regra 3: buscar o agente na lista
  const found = agents.find((a) => a.id === trimmedId)
  if (!found) {
    const availableIds = agents.map((a) => a.id).filter(Boolean)
    const suggestion = availableIds.length > 0
      ? ` Agentes disponíveis no gateway: ${availableIds.join(', ')}.`
      : ' Nenhum agente registrado no gateway.'
    return {
      ok: false,
      agentId: trimmedId,
      reason: `Agente "${trimmedId}" não encontrado no gateway OpenClaw.${suggestion} ` +
              `Registre o agente com: openclaw agents add ${trimmedId} --workspace <pasta> --model <modelo> --non-interactive`,
      failureKind: 'agent_not_found',
    }
  }

  // Agente encontrado
  return {
    ok: true,
    agentId: trimmedId,
    ...(found.workspace ? { workspace: found.workspace } : {}),
  }
}

/**
 * Formata relatório de verificação do agente para log/erro.
 */
export function formatAgentVerificationReport(result: AgentVerificationResult): string {
  if (result.ok) {
    const parts = ['✅ Agente confirmado no gateway']
    parts.push(`id="${result.agentId}"`)
    if (result.workspace) parts.push(`workspace="${result.workspace}"`)
    return parts.join(' | ')
  }

  const kindLabel = result.failureKind
    ? ` [${result.failureKind}]`
    : ''
  return `❌ Verificação do agente falhou${kindLabel}: ${result.reason}`
}

/**
 * Verifica se o resultado indica falha que deve bloquear o enqueue.
 * Todas as falhas bloqueiam — não há "aviso" sem bloqueio.
 */
export function shouldBlockEnqueue(result: AgentVerificationResult): boolean {
  return !result.ok
}
