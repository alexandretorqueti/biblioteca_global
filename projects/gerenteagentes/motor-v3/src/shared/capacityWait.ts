import type { PoolConnection } from 'mysql2/promise'

/**
 * Forma canônica de limpeza dos flags de espera de capacidade (task-p2-1059).
 *
 * As 8 colunas capacity_wait_* de task_runtime_facts (phase, reason_code,
 * limit_scope, limit_value, provider, since, retry_at, alert_at) devem ser
 * nullificadas por TODO writer que grave terminal_status, na mesma
 * transação/escrita. Sem isso, flags residuais de uma espera anterior
 * sobrevivem à conclusão e o Mapa de agentes projeta ampulheta em tarefa
 * já concluída/deployada (incidentes 1023 e 1047, 2026-11-03).
 *
 * Fatos verificados (não inventar writer novo):
 * - Nenhum writer grava terminal_status='failed' hoje — a falha é derivada
 *   de subtarefa 'failed' na projeção de status, sem fato terminal.
 * - Deploy succeeded NÃO escreve task_runtime_facts: o deploy já exige
 *   terminal_status='completed', portanto está coberto pela limpeza na
 *   conclusão + guarda defensiva da projeção.
 */
export const CAPACITY_WAIT_CLEAR_ASSIGNMENTS = [
  'capacity_wait_phase = NULL',
  'capacity_wait_reason_code = NULL',
  'capacity_wait_limit_scope = NULL',
  'capacity_wait_limit_value = NULL',
  'capacity_wait_provider = NULL',
  'capacity_wait_since = NULL',
  'capacity_wait_retry_at = NULL',
  'capacity_wait_alert_at = NULL',
].join(', ')

/**
 * Limpeza canônica das 8 colunas capacity_wait_* via UPDATE. Usar dentro da
 * mesma transação que grava o estado terminal (ou onde a espera termina).
 */
export async function clearCapacityWait(connection: PoolConnection, taskId: number): Promise<void> {
  await connection.query(
    `UPDATE task_runtime_facts
        SET ${CAPACITY_WAIT_CLEAR_ASSIGNMENTS}, updated_at = NOW()
      WHERE tarefa_id = ?`,
    [taskId],
  )
}
