-- Observabilidade de execução (aditiva).
-- Não atualiza nem remove dados existentes. Aplicar no schema projeto_640.

ALTER TABLE `tarefas`
  ADD COLUMN `weight` decimal(10,2) NULL,
  ADD COLUMN `planned_start` timestamp NULL,
  ADD COLUMN `planned_end` timestamp NULL,
  ADD COLUMN `estimated_effort_minutes` int NULL,
  ADD COLUMN `priority` int NULL,
  ADD COLUMN `critical_path` boolean NULL,
  ADD COLUMN `baseline_version` varchar(64) NULL,
  ADD COLUMN `deployed_at` timestamp NULL,
  ADD COLUMN `smoke_test_at` timestamp NULL,
  ADD COLUMN `smoke_test_ok` boolean NULL,
  ADD COLUMN `rollback_at` timestamp NULL,
  ADD COLUMN `incident_id` varchar(200) NULL,
  ADD COLUMN `customer_impact` boolean NULL;
--> statement-breakpoint
ALTER TABLE `subtarefas`
  ADD COLUMN `weight` decimal(10,2) NULL,
  ADD COLUMN `planned_start` timestamp NULL,
  ADD COLUMN `planned_end` timestamp NULL,
  ADD COLUMN `estimated_effort_minutes` int NULL,
  ADD COLUMN `priority` int NULL,
  ADD COLUMN `critical_path` boolean NULL,
  ADD COLUMN `baseline_version` varchar(64) NULL,
  ADD COLUMN `verified_at` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `bloqueios`
  ADD COLUMN `resolved_at` timestamp NULL,
  ADD COLUMN `category` varchar(80) NULL,
  ADD COLUMN `severity` varchar(30) NULL,
  ADD COLUMN `owner_id` varchar(200) NULL,
  ADD COLUMN `root_cause` text NULL,
  ADD COLUMN `resolution` text NULL,
  ADD COLUMN `recurrence_fingerprint` varchar(128) NULL;
--> statement-breakpoint
CREATE INDEX `idx_bloqueios_tarefa_status_date` ON `bloqueios` (`tarefa_id`, `resolved_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_bloqueios_recurrence_fingerprint` ON `bloqueios` (`recurrence_fingerprint`);
--> statement-breakpoint
CREATE TABLE `execution_attempts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `subtask_id` bigint unsigned NOT NULL,
  `attempt_number` int NOT NULL,
  `started_at` timestamp NOT NULL,
  `finished_at` timestamp NULL,
  `outcome` varchar(40) NULL,
  `rework_reason` text NULL,
  `agent_id` varchar(200) NULL,
  `model` varchar(150) NULL,
  `execution_id` varchar(200) NULL,
  `workspace_path` varchar(1000) NULL,
  `base_commit` varchar(64) NULL,
  `result_commit` varchar(64) NULL,
  `token_input` bigint unsigned NULL,
  `token_output` bigint unsigned NULL,
  `cost_usd` decimal(12,6) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_execution_attempts_subtask_number` (`subtask_id`, `attempt_number`),
  KEY `idx_execution_attempts_execution_id` (`execution_id`),
  CONSTRAINT `execution_attempts_subtask_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtarefas` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `execution_events` (
  `event_id` varchar(128) NOT NULL,
  `occurred_at` timestamp NOT NULL,
  `task_id` bigint unsigned NOT NULL,
  `subtask_id` bigint unsigned NULL,
  `attempt_id` bigint unsigned NULL,
  `event_type` varchar(60) NOT NULL,
  `from_status` varchar(50) NULL,
  `to_status` varchar(50) NULL,
  `actor_type` varchar(30) NOT NULL,
  `agent_id` varchar(200) NULL,
  `model` varchar(150) NULL,
  `execution_id` varchar(200) NULL,
  `workspace_commit` varchar(64) NULL,
  `reason_code` varchar(60) NULL,
  `correlation_id` varchar(128) NOT NULL,
  PRIMARY KEY (`event_id`),
  KEY `idx_execution_events_subtask` (`subtask_id`),
  KEY `idx_execution_events_attempt` (`attempt_id`),
  KEY `idx_execution_events_occurred_at` (`occurred_at`),
  KEY `idx_execution_events_event_type` (`event_type`),
  KEY `idx_execution_events_correlation` (`correlation_id`),
  CONSTRAINT `execution_events_task_fk` FOREIGN KEY (`task_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `execution_events_subtask_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `execution_events_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `execution_attempts` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `gate_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `attempt_id` bigint unsigned NOT NULL,
  `gate_type` varchar(40) NOT NULL,
  `command` varchar(1000) NULL,
  `started_at` timestamp NOT NULL,
  `finished_at` timestamp NULL,
  `duration_ms` bigint unsigned NULL,
  `exit_code` int NULL,
  `status` varchar(30) NOT NULL,
  `failure_fingerprint` varchar(128) NULL,
  `evidence_json` json NULL,
  PRIMARY KEY (`id`),
  KEY `idx_gate_runs_attempt_type` (`attempt_id`, `gate_type`),
  KEY `idx_gate_runs_started_at` (`started_at`),
  KEY `idx_gate_runs_failure_fingerprint` (`failure_fingerprint`),
  CONSTRAINT `gate_runs_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `execution_attempts` (`id`) ON DELETE CASCADE
);
