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

/**
 * Bloqueio sistêmico gravado somente na tarefa (`subtarefa_id IS NULL`).
 *
 * Alguns caminhos antigos espelharam a falha na tarefa sem criar o bloqueio
 * correspondente na subtarefa. Associamos esse fato à subtarefa bloqueada que
 * não possui bloqueio próprio; promoção e entrega continuam explicitamente
 * excluídas pela política de bloqueadores.
 */
export function taskLevelSystemBlockedSubtaskSql(): string {
  return (
    "SELECT b.id AS block_id, b.block_reason, COALESCE(b.block_command, '') AS block_command, " +
    "COALESCE(b.block_excerpt, '') AS block_excerpt, s.id AS subtarefa_id, s.seq, t.id AS tarefa_id, t.external_id, " +
    "0 AS orphan " +
    "FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id " +
    "INNER JOIN subtarefas s ON s.tarefa_id = t.id AND s.status = 'blocked' " +
    "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
    "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL " +
    `AND b.block_reason IN ${SYSTEM_BLOCK_REASON_SQL_LIST} ` +
    `AND b.blocked_at < DATE_SUB(NOW(), INTERVAL ${SYSTEM_BLOCK_COOLDOWN_SECONDS} SECOND) ` +
    "AND f.terminal_status IS NULL AND f.integration_confirmed_at IS NULL " +
    `AND NOT ${tarefaDeployadaSql("t")} ` +
    `AND NOT ${promotionBlockerSqlFilter("b")} ` +
    "AND NOT EXISTS (SELECT 1 FROM bloqueios own WHERE own.subtarefa_id = s.id AND own.resolved_at IS NULL) " +
    "AND NOT EXISTS (SELECT 1 FROM motor_active_executions e WHERE e.subtarefa_id = s.id AND e.expires_at > NOW()) " +
    "ORDER BY b.blocked_at ASC LIMIT 5"
  )
}

/**
 * Bloqueios espelhados no nível da TAREFA (`subtarefa_id` nulo) com causa de
 * sistema/ambiente. Eles nascem junto do bloqueio da subtarefa; depois da
 * retomada automática continuam abertos e mantêm a tarefa fora da seleção —
 * anulando a retomada (caso real: task-p2-812 em 2026-09-11, bloqueio 841).
 *
 * Resolve o espelho no mesmo ciclo em que a subtarefa é retomada. Idempotente e
 * restrito a causa de sistema, nunca a bloqueio de promoção/entrega.
 */
export function resolveTaskLevelSystemBlockersSql(): string {
  return (
    "UPDATE bloqueios b SET b.resolved_at = NOW() " +
    "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL AND b.tarefa_id = ? " +
    `AND b.block_reason IN ${SYSTEM_BLOCK_REASON_SQL_LIST} ` +
    `AND NOT ${promotionBlockerSqlFilter("b")}`
  )
}

/**
 * Bloqueio espelhado no nível da TAREFA cuja causa já não existe: a tarefa tem
 * subtarefas e **nenhuma** está `blocked`. Acontece quando a subtarefa é
 * retomada (ou o bloqueio dela é resolvido) e o espelho fica para trás — a
 * tarefa continua fora da seleção sem motivo (caso real: task-p2-812, bloqueio
 * 841, 2026-09-11).
 *
 * Exigir "tem subtarefas e nenhuma blocked" protege os casos legítimos: tarefa
 * sem plano (falha de análise) e tarefa com subtarefa ainda bloqueada ficam de
 * fora.
 */
export function orphanTaskLevelBlockerSql(): string {
  return (
    "SELECT b.id, b.tarefa_id, COALESCE(b.block_reason, '') AS block_reason, " +
    "COALESCE(b.block_command, '') AS block_command, COALESCE(b.block_excerpt, '') AS block_excerpt, " +
    "t.external_id, b.blocked_at " +
    "FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id " +
    "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL " +
    `AND b.block_reason IN ${SYSTEM_BLOCK_REASON_SQL_LIST} ` +
    `AND b.blocked_at < DATE_SUB(NOW(), INTERVAL ${SYSTEM_BLOCK_COOLDOWN_SECONDS} SECOND) ` +
    `AND NOT ${promotionBlockerSqlFilter("b")} ` +
    "AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) " +
    "AND NOT EXISTS (SELECT 1 FROM subtarefas s2 WHERE s2.tarefa_id = t.id AND s2.status = 'blocked') " +
    "LIMIT 20"
  )
}
