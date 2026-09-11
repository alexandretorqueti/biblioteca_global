/**
 * Consultas das varreduras automáticas de bloqueio que rodam no `pump`.
 *
 * Ficam num módulo próprio (e não inline no coordenador) para que a política e
 * o SQL fiquem no mesmo lugar, sejam testáveis e não divirjam — mesmo padrão de
 * `PromotionBlockers`/`SystemBlockers`.
 *
 * Regra de ouro destas varreduras: só mexem em estado que **ninguém mais** vai
 * resolver — bloqueio de tarefa já concluída e subtarefa bloqueada por falha do
 * Motor/ambiente. Bloqueio de entrega (dev não entregou, gate reprovou, deploy
 * falhou) continua exigindo o fluxo dono/humano.
 */

import { promotionBlockerSqlFilter } from "./PromotionBlockers.js"
import { SYSTEM_BLOCK_COOLDOWN_SECONDS, SYSTEM_BLOCK_REASON_SQL_LIST } from "./SystemBlockers.js"

/** A tarefa já está na base (integração confirmada). */
export function tarefaIntegradaSql(alias = "t"): string {
  return `EXISTS (SELECT 1 FROM task_runtime_facts f WHERE f.tarefa_id = ${alias}.id AND f.integration_confirmed_at IS NOT NULL)`
}

/** A tarefa já teve deploy concluído. */
export function tarefaDeployadaSql(alias = "t"): string {
  return `EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = ${alias}.id AND d.status = 'succeeded')`
}

/**
 * Tarefa que concluiu o ciclo: na base, deployada e sem subtarefa fora do
 * estado terminal. É a definição de "acabou" — a partir daí, bloqueio aberto é
 * histórico, não proteção.
 */
export function tarefaConcluidaSql(alias = "t"): string {
  return (
    `(${tarefaIntegradaSql(alias)} AND ${tarefaDeployadaSql(alias)} AND NOT EXISTS ` +
    `(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = ${alias}.id AND s.status NOT IN ('verified', 'superseded')))`
  )
}

/**
 * Bloqueios obsoletos: de promoção em tarefa já integrada/deployada, ou
 * qualquer bloqueio em tarefa concluída.
 */
export function staleBlockerSweepSql(): string {
  return (
    "SELECT b.id, b.tarefa_id, b.subtarefa_id, COALESCE(b.block_reason, '') AS block_reason, " +
    "COALESCE(b.block_command, '') AS block_command, COALESCE(b.block_excerpt, '') AS block_excerpt, " +
    "t.external_id, " + tarefaIntegradaSql("t") + " AS integrada, " + tarefaDeployadaSql("t") + " AS deployada " +
    "FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id " +
    "WHERE b.resolved_at IS NULL AND " +
    `((${promotionBlockerSqlFilter("b")} AND (${tarefaIntegradaSql("t")} OR ${tarefaDeployadaSql("t")})) ` +
    "OR " + tarefaConcluidaSql("t") + ") " +
    "LIMIT 50"
  )
}

/** Subtarefa bloqueada por falha do Motor/ambiente, com o bloqueio que a travou. */
export function systemBlockedSubtaskSql(): string {
  return (
    "SELECT b.id AS block_id, b.block_reason, COALESCE(b.block_command, '') AS block_command, " +
    "COALESCE(b.block_excerpt, '') AS block_excerpt, s.id AS subtarefa_id, s.seq, t.id AS tarefa_id, t.external_id, " +
    "0 AS orphan " +
    "FROM bloqueios b " +
    "INNER JOIN subtarefas s ON s.id = b.subtarefa_id " +
    "INNER JOIN tarefas t ON t.id = b.tarefa_id " +
    "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
    "WHERE b.resolved_at IS NULL AND s.status = 'blocked' " +
    "AND b.block_reason IN " + SYSTEM_BLOCK_REASON_SQL_LIST + " " +
    `AND b.blocked_at < DATE_SUB(NOW(), INTERVAL ${SYSTEM_BLOCK_COOLDOWN_SECONDS} SECOND) ` +
    "AND f.terminal_status IS NULL AND f.integration_confirmed_at IS NULL " +
    `AND NOT ${tarefaDeployadaSql("t")} ` +
    "AND NOT EXISTS (SELECT 1 FROM motor_active_executions e WHERE e.subtarefa_id = s.id AND e.expires_at > NOW()) " +
    `AND NOT EXISTS (SELECT 1 FROM bloqueios b2 WHERE b2.tarefa_id = t.id AND b2.resolved_at IS NULL AND ${promotionBlockerSqlFilter("b2")}) ` +
    "ORDER BY b.blocked_at ASC LIMIT 5"
  )
}

/**
 * Subtarefa `blocked` **sem nenhum bloqueio aberto** na tarefa: a evidência foi
 * resolvida (runbook, higiene ou fluxo) mas o status ficou `blocked` — ninguém
 * mais olharia para ela. Só entra quando a tarefa não tem bloqueio aberto algum.
 */
export function orphanBlockedSubtaskSql(): string {
  return (
    "SELECT s.id AS subtarefa_id, s.seq, t.id AS tarefa_id, t.external_id, s.updated_at, " +
    "'' AS block_reason, '' AS block_command, '' AS block_excerpt, NULL AS block_id, 1 AS orphan " +
    "FROM subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id " +
    "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
    "WHERE s.status = 'blocked' " +
    "AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.subtarefa_id = s.id AND b.resolved_at IS NULL) " +
    `AND s.updated_at < DATE_SUB(NOW(), INTERVAL ${SYSTEM_BLOCK_COOLDOWN_SECONDS} SECOND) ` +
    "AND f.terminal_status IS NULL AND f.integration_confirmed_at IS NULL " +
    `AND NOT ${tarefaDeployadaSql("t")} ` +
    "AND NOT EXISTS (SELECT 1 FROM motor_active_executions e WHERE e.subtarefa_id = s.id AND e.expires_at > NOW()) " +
    "AND NOT EXISTS (SELECT 1 FROM bloqueios b3 WHERE b3.tarefa_id = t.id AND b3.resolved_at IS NULL) " +
    "ORDER BY s.updated_at ASC LIMIT 5"
  )
}
