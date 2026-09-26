-- Governança de comandos e trilha operacional do Motor v3.
-- Idempotente: segura para deploy blue/green e reaplicação controlada.

CREATE TABLE IF NOT EXISTS `motor_commands` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(100) NOT NULL,
  `message_type` varchar(200) NOT NULL,
  `name` varchar(255) NOT NULL,
  `scope` enum('global','projeto','tarefa','subtarefa') NOT NULL DEFAULT 'tarefa',
  `handler_code` varchar(100) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `version` int unsigned NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `motor_commands_code_unique` (`code`),
  UNIQUE KEY `motor_commands_message_type_unique` (`message_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `motor_command_policies` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `command_id` int unsigned NOT NULL,
  `code` varchar(100) NOT NULL,
  `name` varchar(255) NOT NULL,
  `priority` int NOT NULL DEFAULT 100,
  `conditions_json` json NOT NULL,
  `action_id` int NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `version` int unsigned NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `motor_command_policies_code_unique` (`code`),
  KEY `motor_command_policies_lookup_idx` (`command_id`,`active`,`priority`),
  CONSTRAINT `motor_command_policies_command_fk` FOREIGN KEY (`command_id`) REFERENCES `motor_commands` (`id`) ON DELETE CASCADE,
  CONSTRAINT `motor_command_policies_action_fk` FOREIGN KEY (`action_id`) REFERENCES `motor_actions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `motor_operation_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `operation_id` char(36) NOT NULL,
  `sequence` int unsigned NOT NULL,
  `phase` enum('received','decision','action','primitive','completed','failed','rejected') NOT NULL,
  `outcome` enum('pending','executed','skipped','rejected','succeeded','failed') NOT NULL,
  `message_id` varchar(200) NOT NULL,
  `message_type` varchar(200) NOT NULL,
  `correlation_id` varchar(200) NULL,
  `causation_id` varchar(200) NULL,
  `tarefa_id` varchar(100) NULL,
  `subtarefa_id` int NULL,
  `command_code` varchar(100) NULL,
  `policy_code` varchar(100) NULL,
  `policy_version` int unsigned NULL,
  `action_code` varchar(100) NULL,
  `action_snapshot_json` json NULL,
  `primitive_code` varchar(100) NULL,
  `input_json` json NULL,
  `result_json` json NULL,
  `reason_code` varchar(100) NULL,
  `duration_ms` int unsigned NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `motor_operation_log_sequence_unique` (`operation_id`,`sequence`),
  KEY `motor_operation_log_message_idx` (`message_id`),
  KEY `motor_operation_log_task_time_idx` (`tarefa_id`,`created_at`),
  KEY `motor_operation_log_correlation_idx` (`correlation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'claim_analysis_atomic', 'Adquirir claim atômico da análise', 'db', 'Valida e reserva a análise da tarefa em transação.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'claim_analysis_atomic');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'emit_analysis_selected', 'Emitir análise selecionada', 'control', 'Registra e publica a seleção de análise.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'emit_analysis_selected');
--> statement-breakpoint

INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'start_analyst', 'Iniciar analista', 'control', 'Inicia o runner de análise para a tarefa com claim ativo.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'start_analyst');
--> statement-breakpoint

INSERT INTO `motor_actions` (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A21_RESUME_TASK_ANALYSIS', 'Retomar análise da tarefa',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'claim_analysis_atomic'),
    JSON_OBJECT('primitive', 'emit_analysis_selected'),
    JSON_OBJECT('primitive', 'start_analyst')
  ),
  'continue', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A21_RESUME_TASK_ANALYSIS');
--> statement-breakpoint

INSERT INTO `motor_commands` (`code`, `message_type`, `name`, `scope`, `handler_code`, `active`, `version`)
VALUES ('C03_TASK_RESUME_REQUESTED', 'TASK_RESUME_REQUESTED', 'Retomada de tarefa solicitada', 'tarefa', 'task_resume', 1, 1)
ON DUPLICATE KEY UPDATE
  `message_type` = VALUES(`message_type`), `name` = VALUES(`name`), `scope` = VALUES(`scope`), `handler_code` = VALUES(`handler_code`), `active` = VALUES(`active`);
--> statement-breakpoint

INSERT INTO `motor_command_policies`
  (`command_id`, `code`, `name`, `priority`, `conditions_json`, `action_id`, `active`, `version`)
SELECT c.id, 'P03_RESUME_IF_ELIGIBLE', 'Retomar análise quando tarefa estiver elegível', 100,
  JSON_OBJECT('all', JSON_ARRAY('task_not_paused', 'task_not_terminal', 'task_not_blocked', 'task_has_no_subtasks', 'analysis_not_claimed')),
  a.id, 1, 1
FROM `motor_commands` c
INNER JOIN `motor_actions` a ON a.code = 'A21_RESUME_TASK_ANALYSIS'
WHERE c.code = 'C03_TASK_RESUME_REQUESTED'
  AND NOT EXISTS (SELECT 1 FROM `motor_command_policies` WHERE `code` = 'P03_RESUME_IF_ELIGIBLE');
