CREATE TABLE IF NOT EXISTS `motor_agent_sessions` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `subtarefa_id` bigint unsigned NOT NULL,
  `agent_id` varchar(100) NOT NULL,
  `model` varchar(200) NOT NULL,
  `session_key` varchar(300) NOT NULL,
  `runtime_session_id` varchar(300),
  `status` varchar(30) NOT NULL DEFAULT 'active',
  `opened_at` timestamp NOT NULL DEFAULT (now()),
  `last_activity_at` timestamp NOT NULL DEFAULT (now()),
  `approved_at` timestamp NULL,
  `closed_at` timestamp NULL,
  `close_reason` varchar(100) NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `motor_agent_sessions_id` PRIMARY KEY(`id`),
  CONSTRAINT `motor_agent_sessions_key_unique` UNIQUE(`session_key`),
  KEY `motor_agent_sessions_subtask_status_idx` (`subtarefa_id`,`status`),
  KEY `motor_agent_sessions_activity_idx` (`last_activity_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `motor_agent_session_messages` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `session_id` bigint unsigned NOT NULL,
  `message_key` varchar(300) NOT NULL,
  `sequence_number` int NOT NULL,
  `role` varchar(30) NOT NULL,
  `content` longtext NOT NULL,
  `content_sha256` char(64) NOT NULL,
  `occurred_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `motor_agent_session_messages_id` PRIMARY KEY(`id`),
  CONSTRAINT `motor_agent_session_messages_unique` UNIQUE(`session_id`,`message_key`),
  KEY `motor_agent_session_messages_session_sequence_idx` (`session_id`,`sequence_number`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tarefas_status_historico` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `status_anterior` varchar(50) NOT NULL,
  `status_novo` varchar(50) NOT NULL,
  `origem` varchar(80) NOT NULL,
  `motivo` varchar(500) NULL,
  `execution_id` varchar(200) NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `tarefas_status_historico_id` PRIMARY KEY(`id`),
  KEY `tarefas_status_historico_task_created_idx` (`tarefa_id`,`created_at`),
  KEY `tarefas_status_historico_status_idx` (`status_novo`,`created_at`)
);
