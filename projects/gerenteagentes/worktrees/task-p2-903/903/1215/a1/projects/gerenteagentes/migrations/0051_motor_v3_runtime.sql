-- Runtime durável do Motor v3 no histórico canônico do GerenteAgentes.
-- Esta migration adota instalações onde as estruturas foram criadas
-- manualmente e também inicializa bancos novos. Todas as operações são
-- idempotentes para permitir blue/green e reinícios concorrentes.

SET @analysis_execution_column_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'task_runtime_facts'
     AND column_name = 'analysis_execution_id'
);
--> statement-breakpoint
SET @analysis_execution_column_sql = IF(
  @analysis_execution_column_exists = 0,
  'ALTER TABLE task_runtime_facts ADD COLUMN analysis_execution_id varchar(200) NULL AFTER analysis_started_at',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE analysis_execution_column_stmt FROM @analysis_execution_column_sql;
--> statement-breakpoint
EXECUTE analysis_execution_column_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE analysis_execution_column_stmt;
--> statement-breakpoint

SET @analysis_execution_idx_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'task_runtime_facts'
     AND index_name = 'task_runtime_facts_analysis_execution_idx'
);
--> statement-breakpoint
SET @analysis_execution_idx_sql = IF(
  @analysis_execution_idx_exists = 0,
  'CREATE INDEX task_runtime_facts_analysis_execution_idx ON task_runtime_facts (analysis_execution_id)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE analysis_execution_idx_stmt FROM @analysis_execution_idx_sql;
--> statement-breakpoint
EXECUTE analysis_execution_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE analysis_execution_idx_stmt;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `motor_outbox` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `message_id` varchar(200) NOT NULL,
  `type` varchar(200) NOT NULL,
  `task_id` varchar(100) NOT NULL,
  `execution_id` varchar(200) NOT NULL,
  `payload_json` json NOT NULL,
  `timestamp` timestamp NOT NULL,
  `correlation_id` varchar(200) NULL,
  `causation_id` varchar(200) NULL,
  `status` enum('pending', 'published') NOT NULL DEFAULT 'pending',
  `attempt` int NOT NULL DEFAULT 0,
  `last_error` text NULL,
  `published_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `motor_outbox_message_id_unique` (`message_id`),
  KEY `motor_outbox_pending_idx` (`status`, `id`),
  KEY `motor_outbox_task_idx` (`task_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `motor_message_processing_state` (
  `message_id` varchar(200) NOT NULL,
  `task_id` varchar(200) NULL,
  `message_type` varchar(50) NOT NULL,
  `status` enum('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `attempt` int NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `started_at` datetime NULL,
  `completed_at` datetime NULL,
  `timeout_at` datetime NULL,
  `error_message` text NULL,
  PRIMARY KEY (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

SET @processing_status_idx_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'motor_message_processing_state'
     AND index_name = 'idx_message_processing_state_status'
);
--> statement-breakpoint
SET @processing_status_idx_sql = IF(
  @processing_status_idx_exists = 0,
  'CREATE INDEX idx_message_processing_state_status ON motor_message_processing_state (status, attempt)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE processing_status_idx_stmt FROM @processing_status_idx_sql;
--> statement-breakpoint
EXECUTE processing_status_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE processing_status_idx_stmt;
--> statement-breakpoint

SET @processing_task_idx_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'motor_message_processing_state'
     AND index_name = 'idx_message_processing_state_task'
);
--> statement-breakpoint
SET @processing_task_idx_sql = IF(
  @processing_task_idx_exists = 0,
  'CREATE INDEX idx_message_processing_state_task ON motor_message_processing_state (task_id, status)',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE processing_task_idx_stmt FROM @processing_task_idx_sql;
--> statement-breakpoint
EXECUTE processing_task_idx_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE processing_task_idx_stmt;
