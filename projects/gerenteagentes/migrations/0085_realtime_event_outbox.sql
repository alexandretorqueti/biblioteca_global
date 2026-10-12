-- Outbox durável do realtime. A mutação canônica e este registro devem usar
-- a mesma transação; motor_outbox não serve para este contrato (RabbitMQ).
-- IF NOT EXISTS: DDL MySQL não é transacional (commit implícito); se o container
-- for interrompido entre o CREATE e o registro no __drizzle_migrations, a tabela
-- órfã não pode bloquear o retry da migration (incidente task-p2-984).
CREATE TABLE IF NOT EXISTS `realtime_event_outbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `event_id` varchar(36) NOT NULL,
  `task_id` bigint unsigned NOT NULL,
  `source_task_id` varchar(64) NULL,
  `project_id` bigint unsigned NOT NULL,
  `subtask_id` bigint unsigned NULL,
  `type` varchar(100) NOT NULL,
  `previous_status` varchar(40) NULL,
  `status` varchar(40) NULL,
  `payload` json NOT NULL,
  `per_task_seq` bigint unsigned NOT NULL,
  `delivery_status` enum('pending','published','failed') NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT 0,
  `last_error` text NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `published_at` timestamp NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `realtime_event_outbox_event_id_uq` (`event_id`),
  KEY `realtime_event_outbox_task_order_idx` (`task_id`, `per_task_seq`),
  KEY `realtime_event_outbox_pending_idx` (`delivery_status`, `task_id`, `per_task_seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
