import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'

/**
 * Alerta deduplicado ao operador no chat da tarefa (`tarefa_chats`) para toda
 * falha terminal de subtarefa que persista bloqueio (tarefa 1043: a falha da
 * subtarefa 1403 deixou 1404/1405 pendentes sem bloqueio, retry ou aviso —
 * a tarefa ficou inerte em silêncio).
 *
 * Padrão derivado de `DeployRepository` (merge_conflict) e
 * `MySqlTaskCoordinatorRepository`: INSERT de mensagem 'assistant' na MESMA
 * transação do bloqueio, com idempotência por marcador do blockId embutido no
 * texto (`INSERT ... SELECT ... WHERE NOT EXISTS` de mensagem com o marcador).
 * Redelivery/repetição da mesma falha não duplica o alerta.
 */

/** Contrato mínimo de conexão transacional (aceita PoolConnection real e mocks de teste). */
export type ChatAlertConnection = Pick<PoolConnection, 'query'>

export interface BlockerChatAlertInput {
  /** Id numérico da tarefa em `tarefas` (tarefa_chats.tarefa_id). */
  databaseTaskId: number
  /** Id do bloqueio recém-criado em `bloqueios`; ancora o marcador de deduplicação. */
  blockId: number
  /** Id externo/legível da tarefa (ex.: task-p2-1043). */
  taskId: string
  subtaskId: number | null
  blockReason: string
  /** Causa legível da falha terminal (mensagem de erro). */
  cause: string
  /** Evidência estruturada (block_excerpt JSON) em formato textual. */
  evidence: string
  /** Ação recomendada ao operador; default derivado do block_reason. */
  nextStep?: string
}

/** Marcador de idempotência do alerta de bloqueio no texto da mensagem. */
export function blockAlertMarker(blockId: number): string {
  return `[motor-v3:block:${blockId}]`
}

/** Ação recomendada legível por tipo de bloqueio terminal. */
export function recommendedActionForBlockReason(blockReason: string): string {
  switch (blockReason) {
    case 'worker_exhausted':
      return 'O programador esgotou as tentativas de execução desta subtarefa. Revise a evidência, corrija a causa raiz e resolva o bloqueio no Mapa de agentes para retomar a partir desta subtarefa.'
    case 'subtask_verification_failed':
      return 'A verificação da subtarefa falhou de forma terminal (reentregas esgotadas). Revise a evidência (gates/migrations), corrija a causa e resolva o bloqueio no Mapa de agentes para reexecutar a verificação.'
    case 'baseline_preflight_failed':
      return 'O baseline/preflight falhou antes do desenvolvimento. Revise a evidência, corrija o ambiente ou os testes e resolva o bloqueio para retomar a subtarefa.'
    case 'development_completion_protocol_exhausted':
      return 'A sessão DEV encerrou repetidamente sem o protocolo ::DONE::. Revise a evidência e resolva o bloqueio para reexecutar a subtarefa.'
    default:
      return 'Falha terminal na execução da subtarefa. Revise a causa e a evidência, corrija o problema e resolva o bloqueio no Mapa de agentes para retomar a partir desta subtarefa.'
  }
}

/** Texto do alerta ao operador: tarefa, subtarefa, causa, evidência e próximo passo. */
export function buildBlockerChatAlertText(input: BlockerChatAlertInput): string {
  const subtask = input.subtaskId != null ? String(input.subtaskId) : '—'
  const nextStep = input.nextStep ?? recommendedActionForBlockReason(input.blockReason)
  return [
    '🚨 **Bloqueio automático — falha terminal de subtarefa**',
    '',
    `**Tarefa:** ${input.taskId} (id ${input.databaseTaskId})`,
    `**Subtarefa:** ${subtask}`,
    `**Causa:** ${input.blockReason} — ${String(input.cause).slice(0, 500)}`,
    `**Evidência:** ${String(input.evidence).slice(0, 1_000)}`,
    `**Próximo passo:** ${nextStep}`,
    '',
    blockAlertMarker(input.blockId),
  ].join('\n')
}

/**
 * INSERT idempotente por marcador: só cria a mensagem 'assistant' se ainda não
 * existir mensagem da mesma tarefa contendo o marcador. Retorna o id/texto da
 * mensagem criada, ou `null` quando ela já existia (redelivery seguro) ou o
 * adaptador não informou affectedRows.
 */
export async function insertDeduplicatedChatMessage(
  connection: ChatAlertConnection,
  databaseTaskId: number,
  marker: string,
  texto: string,
): Promise<{ id: number; texto: string } | null> {
  const result = await connection.query<ResultSetHeader>(
    `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at)
     SELECT ?, 'assistant', ?, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM tarefa_chats existing
          WHERE existing.tarefa_id = ?
            AND existing.texto LIKE ?
       )`,
    [databaseTaskId, texto, databaseTaskId, `%${marker}%`],
  )
  const header = Array.isArray(result) ? result[0] : undefined
  if (!header || Number(header.affectedRows ?? 0) === 0) return null
  return { id: Number(header.insertId ?? 0), texto }
}

/** Alerta de bloqueio terminal deduplicado pelo marcador do blockId. */
export async function insertBlockerChatAlert(
  connection: ChatAlertConnection,
  input: BlockerChatAlertInput,
): Promise<{ id: number; texto: string } | null> {
  if (!Number.isInteger(input.blockId) || input.blockId <= 0) return null
  if (!Number.isInteger(input.databaseTaskId) || input.databaseTaskId <= 0) return null
  return insertDeduplicatedChatMessage(
    connection,
    input.databaseTaskId,
    blockAlertMarker(input.blockId),
    buildBlockerChatAlertText(input),
  )
}
