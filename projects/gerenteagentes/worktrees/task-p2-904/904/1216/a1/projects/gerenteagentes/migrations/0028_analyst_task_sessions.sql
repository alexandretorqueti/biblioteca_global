-- Histórico persistente de sessões do analista no nível da tarefa.
-- Permite consultar a sessão do analista mesmo após a sessão operacional ser apagada.
-- Suporta múltiplas sessões por tarefa (escalonamento) com ordenação determinística.
CREATE TABLE IF NOT EXISTS `analyst_task_sessions` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `session_key` varchar(300) NOT NULL,
  `runtime_session_id` varchar(300) NULL,
  `model` varchar(200) NOT NULL,
  `execution_order` int NOT NULL,
  `status` varchar(30) NOT NULL DEFAULT 'active',
  `opened_at` timestamp NOT NULL DEFAULT (now()),
  `last_activity_at` timestamp NOT NULL DEFAULT (now()),
  `closed_at` timestamp NULL,
  `close_reason` varchar(100) NULL,
  `summary` text NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `analyst_task_sessions_id` PRIMARY KEY(`id`),
  CONSTRAINT `analyst_task_sessions_task_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  KEY `analyst_task_sessions_task_order_idx` (`tarefa_id`, `execution_order`),
  KEY `analyst_task_sessions_session_key_idx` (`session_key`(191)),
  KEY `analyst_task_sessions_status_idx` (`status`, `last_activity_at`)
);
--> statement-breakpoint
-- Mensagens das sessões do analista no nível da tarefa.
-- Conteúdo persistido independentemente da sessão operacional.
CREATE TABLE IF NOT EXISTS `analyst_task_session_messages` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `session_id` bigint unsigned NOT NULL,
  `message_key` varchar(300) NOT NULL,
  `sequence_number` int NOT NULL,
  `role` varchar(30) NOT NULL,
  `content` longtext NOT NULL,
  `content_sha256` char(64) NOT NULL,
  `occurred_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `analyst_task_session_messages_id` PRIMARY KEY(`id`),
  CONSTRAINT `analyst_task_session_messages_session_fk` FOREIGN KEY (`session_id`) REFERENCES `analyst_task_sessions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `analyst_task_session_messages_unique` UNIQUE(`session_id`, `message_key`),
  KEY `analyst_task_session_messages_session_sequence_idx` (`session_id`, `sequence_number`)
);
