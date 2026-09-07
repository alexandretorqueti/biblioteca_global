-- Observabilidade de execução do Motor (aditiva e reversível).
-- Rollback: executar migrations/rollback/0024_motor_execution_observability.sql

ALTER TABLE `tarefas`
  ADD COLUMN `weight` decimal(10,2) NULL,
  ADD COLUMN `planned_start` timestamp NULL,
  ADD COLUMN `planned_end` timestamp NULL,
  ADD COLUMN `estimated_effort_minutes` int NULL,
  ADD COLUMN `priority` int NULL,
  ADD COLUMN `critical_path` boolean NOT NULL DEFAULT false,
  ADD COLUMN `baseline_version` varchar(64) NULL;

ALTER TABLE `subtarefas`
  ADD COLUMN `weight` decimal(10,2) NULL,
  ADD COLUMN `planned_start` timestamp NULL,
  ADD COLUMN `planned_end` timestamp NULL,
  ADD COLUMN `estimated_effort_minutes` int NULL,
  ADD COLUMN `priority` int NULL,
  ADD COLUMN `critical_path` boolean NOT NULL DEFAULT false,
  ADD COLUMN `baseline_version` varchar(64) NULL,
  ADD COLUMN `verified_at` timestamp NULL,
  ADD COLUMN `deployed_at` timestamp NULL,
  ADD COLUMN `smoke_test_at` timestamp NULL,
  ADD COLUMN `smoke_test_ok` boolean NULL,
  ADD COLUMN `rollback_at` timestamp NULL,
  ADD COLUMN `incident_id` varchar(128) NULL,
  ADD COLUMN `customer_impact` boolean NULL;

ALTER TABLE `bloqueios`
  ADD COLUMN `status` enum('open','resolved','cancelled') NOT NULL DEFAULT 'open',
  ADD COLUMN `category` varchar(64) NULL,
  ADD COLUMN `severity` varchar(32) NULL,
  ADD COLUMN `owner_id` varchar(150) NULL,
  ADD COLUMN `root_cause` text NULL,
  ADD COLUMN `resolution` text NULL,
  ADD COLUMN `resolved_at` timestamp NULL,
  ADD COLUMN `recurrence_fingerprint` varchar(128) NULL;

ALTER TABLE `tarefas`
  ADD INDEX `tarefas_baseline_period_idx` (`projeto_id`, `planned_start`, `planned_end`);

ALTER TABLE `subtarefas`
  ADD INDEX `subtarefas_baseline_period_idx` (`tarefa_id`, `planned_start`, `planned_end`),
  ADD INDEX `subtarefas_deploy_smoke_idx` (`deployed_at`, `smoke_test_ok`);

ALTER TABLE `bloqueios`
  ADD INDEX `bloqueios_subtask_status_idx` (`subtarefa_id`, `status`, `blocked_at`),
  ADD INDEX `bloqueios_recurrence_idx` (`recurrence_fingerprint`);

CREATE TABLE `execution_attempts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `subtask_id` bigint unsigned NOT NULL,
  `attempt_number` int NOT NULL,
  `started_at` timestamp NOT NULL DEFAULT (now()),
  `finished_at` timestamp NULL,
  `outcome` varchar(32) NULL,
  `rework_reason` text NULL,
  `agent_id` varchar(150) NULL,
  `model` varchar(150) NULL,
  `execution_id` varchar(200) NULL,
  `workspace_path` varchar(1000) NULL,
  `base_commit` varchar(64) NULL,
  `result_commit` varchar(64) NULL,
  `token_input` bigint unsigned NULL,
  `token_output` bigint unsigned NULL,
  `cost_usd` decimal(12,6) NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `execution_attempts_id` PRIMARY KEY (`id`),
  CONSTRAINT `execution_attempts_subtask_attempt_unique` UNIQUE (`subtask_id`, `attempt_number`),
  CONSTRAINT `execution_attempts_subtask_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtarefas` (`id`) ON DELETE CASCADE,
  INDEX `execution_attempts_subtask_started_idx` (`subtask_id`, `started_at`),
  INDEX `execution_attempts_execution_idx` (`execution_id`)
);

CREATE TABLE `execution_events` (
  `event_id` varchar(36) NOT NULL,
  `occurred_at` timestamp NOT NULL DEFAULT (now()),
  `task_id` bigint unsigned NULL,
  `subtask_id` bigint unsigned NULL,
  `attempt_id` bigint unsigned NULL,
  `event_type` varchar(64) NOT NULL,
  `from_status` varchar(50) NULL,
  `to_status` varchar(50) NULL,
  `actor_type` varchar(32) NOT NULL,
  `agent_id` varchar(150) NULL,
  `model` varchar(150) NULL,
  `execution_id` varchar(200) NULL,
  `workspace_commit` varchar(64) NULL,
  `reason_code` varchar(64) NULL,
  `correlation_id` varchar(128) NOT NULL,
  CONSTRAINT `execution_events_id` PRIMARY KEY (`event_id`),
  CONSTRAINT `execution_events_task_fk` FOREIGN KEY (`task_id`) REFERENCES `tarefas` (`id`) ON DELETE SET NULL,
  CONSTRAINT `execution_events_subtask_fk` FOREIGN KEY (`subtask_id`) REFERENCES `subtarefas` (`id`) ON DELETE SET NULL,
  CONSTRAINT `execution_events_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `execution_attempts` (`id`) ON DELETE SET NULL,
  INDEX `execution_events_subtask_idx` (`subtask_id`, `occurred_at`),
  INDEX `execution_events_task_idx` (`task_id`, `occurred_at`),
  INDEX `execution_events_attempt_idx` (`attempt_id`, `occurred_at`),
  INDEX `execution_events_type_idx` (`event_type`, `occurred_at`),
  INDEX `execution_events_correlation_idx` (`correlation_id`)
);

CREATE TABLE `gate_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `attempt_id` bigint unsigned NOT NULL,
  `gate_type` varchar(32) NOT NULL,
  `command` varchar(1000) NULL,
  `started_at` timestamp NOT NULL DEFAULT (now()),
  `finished_at` timestamp NULL,
  `duration_ms` bigint unsigned NULL,
  `exit_code` int NULL,
  `status` enum('passed','failed','skipped','error') NOT NULL,
  `failure_fingerprint` varchar(128) NULL,
  `evidence_json` json NULL,
  CONSTRAINT `gate_runs_id` PRIMARY KEY (`id`),
  CONSTRAINT `gate_runs_attempt_fk` FOREIGN KEY (`attempt_id`) REFERENCES `execution_attempts` (`id`) ON DELETE CASCADE,
  INDEX `gate_runs_attempt_type_idx` (`attempt_id`, `gate_type`, `started_at`),
  INDEX `gate_runs_status_idx` (`status`, `started_at`),
  INDEX `gate_runs_failure_idx` (`failure_fingerprint`)
);
