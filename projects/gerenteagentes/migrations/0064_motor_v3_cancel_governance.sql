-- Governança do cancelamento de tarefas no Motor v3 (incidente 862, itens 1 e 2).
-- Registra o comando C04_TASK_CANCEL_REQUESTED com política P04 e ação A22,
-- mais as primitivas auditáveis usadas pelo TaskCancelConsumer e pelo bloqueio
-- de falha definitiva de análise.
-- Idempotente: segura para deploy blue/green e reaplicação controlada.

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'release_analysis_claim', 'Liberar claim de análise', 'db', 'Limpa analysis_started_at/analysis_execution_id de task_runtime_facts.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'release_analysis_claim');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'resolve_task_blockers', 'Resolver bloqueios da tarefa', 'db', 'Marca resolved_at nos bloqueios ativos da tarefa.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'resolve_task_blockers');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'mark_task_cancelled', 'Marcar tarefa como cancelada', 'db', 'Grava terminal_status=cancelled em task_runtime_facts (upsert).'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'mark_task_cancelled');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'record_task_event', 'Registrar evento de tarefa', 'db', 'Insere trilha imutável em tarefa_eventos com origem=motor.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'record_task_event');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'block_task_for_analysis_failure', 'Bloquear tarefa por falha de análise', 'db', 'Persiste bloqueio analysis_failed na tentativa final (estação Atenção).'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'block_task_for_analysis_failure');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'release_orphan_analysis_claim', 'Liberar claim órfão de análise', 'db', 'Libera claim quando a mesma mensagem durável retorna após queda do Motor.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'release_orphan_analysis_claim');
--> statement-breakpoint

INSERT INTO `motor_actions` (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A22_CANCEL_TASK', 'Cancelar tarefa',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'release_analysis_claim'),
    JSON_OBJECT('primitive', 'resolve_task_blockers'),
    JSON_OBJECT('primitive', 'mark_task_cancelled'),
    JSON_OBJECT('primitive', 'record_task_event')
  ),
  'continue', 1, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A22_CANCEL_TASK');
--> statement-breakpoint

INSERT INTO `motor_commands` (`code`, `message_type`, `name`, `scope`, `handler_code`, `active`, `version`)
VALUES ('C04_TASK_CANCEL_REQUESTED', 'TASK_CANCEL_REQUESTED', 'Cancelamento de tarefa solicitado', 'tarefa', 'task_cancel', 1, 1)
ON DUPLICATE KEY UPDATE
  `message_type` = VALUES(`message_type`), `name` = VALUES(`name`), `scope` = VALUES(`scope`), `handler_code` = VALUES(`handler_code`), `active` = VALUES(`active`);
--> statement-breakpoint

INSERT INTO `motor_command_policies`
  (`command_id`, `code`, `name`, `priority`, `conditions_json`, `action_id`, `active`, `version`)
SELECT c.id, 'P04_CANCEL_IF_NOT_TERMINAL', 'Cancelar tarefa quando não estiver em estado terminal', 100,
  JSON_OBJECT('all', JSON_ARRAY('task_not_terminal')),
  a.id, 1, 1
FROM `motor_commands` c
INNER JOIN `motor_actions` a ON a.code = 'A22_CANCEL_TASK'
WHERE c.code = 'C04_TASK_CANCEL_REQUESTED'
  AND NOT EXISTS (SELECT 1 FROM `motor_command_policies` WHERE `code` = 'P04_CANCEL_IF_NOT_TERMINAL');
