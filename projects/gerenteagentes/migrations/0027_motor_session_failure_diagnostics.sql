-- Diagnóstico estruturado retornado pelo Console/OpenClaw.
-- Cada ocorrência é append-only: uma nova tentativa nunca sobrescreve a anterior.
CREATE TABLE IF NOT EXISTS `motor_agent_session_failures` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `subtarefa_id` bigint unsigned NULL,
  `agent_id` varchar(100) NOT NULL,
  `session_key` varchar(300) NOT NULL,
  `runtime_session_id` varchar(300) NULL,
  `run_id` varchar(300) NOT NULL,
  `code` varchar(120) NOT NULL,
  `message` varchar(500) NOT NULL,
  `occurred_at` timestamp NOT NULL,
  `observed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `scope` varchar(20) NOT NULL DEFAULT 'session',
  `classification` varchar(20) NOT NULL,
  `classification_reason` varchar(160) NOT NULL,
  `fingerprint` varchar(600) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `motor_agent_session_failures_id` PRIMARY KEY(`id`),
  CONSTRAINT `motor_agent_session_failures_task_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `motor_agent_session_failures_subtask_fk` FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas` (`id`) ON DELETE SET NULL,
  KEY `motor_agent_session_failures_task_idx` (`tarefa_id`,`created_at`),
  KEY `motor_agent_session_failures_agent_idx` (`agent_id`,`created_at`),
  KEY `motor_agent_session_failures_fingerprint_idx` (`fingerprint`(191),`created_at`)
);
