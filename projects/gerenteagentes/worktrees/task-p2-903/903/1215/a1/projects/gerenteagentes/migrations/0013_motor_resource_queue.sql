-- Recursos, leases e fila persistida do Motor v2.
-- Todas as estruturas pertencem ao schema isolado projeto_<id>.

CREATE TABLE IF NOT EXISTS `execution_resources` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `resource_key` varchar(200) NOT NULL,
  `execution_id` varchar(200) NOT NULL,
  `owner_id` varchar(200) NOT NULL,
  `fencing_token` int NOT NULL DEFAULT 1,
  `heartbeat_at` timestamp NOT NULL,
  `acquired_at` timestamp NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `execution_resources_id` PRIMARY KEY(`id`),
  CONSTRAINT `execution_resources_resource_key_unique` UNIQUE(`resource_key`)
);

--> statement-breakpoint

DROP PROCEDURE IF EXISTS `__bg_ensure_index`;

--> statement-breakpoint

CREATE PROCEDURE `__bg_ensure_index`(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND index_name = p_index
  ) THEN
    SET @bg_index_sql = CONCAT(
      'CREATE INDEX `', p_index, '` ON `', p_table, '` (', p_columns, ')'
    );
    PREPARE bg_index_stmt FROM @bg_index_sql;
    EXECUTE bg_index_stmt;
    DEALLOCATE PREPARE bg_index_stmt;
  END IF;
END;

--> statement-breakpoint

CALL `__bg_ensure_index`(
  'execution_resources',
  'idx_execution_resources_expires_at',
  '`expires_at`'
);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `execution_resource_queue` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `resource_key` varchar(200) NOT NULL,
  `execution_id` varchar(200) NOT NULL,
  `task_id` varchar(200) NOT NULL,
  `priority` int NOT NULL DEFAULT 0,
  `requested_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `status` varchar(20) NOT NULL DEFAULT 'waiting',
  CONSTRAINT `execution_resource_queue_id` PRIMARY KEY(`id`)
);

--> statement-breakpoint

DROP PROCEDURE IF EXISTS `__bg_ensure_column`;

--> statement-breakpoint

CREATE PROCEDURE `__bg_ensure_column`(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table
      AND column_name = p_column
  ) THEN
    SET @bg_column_sql = CONCAT(
      'ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition
    );
    PREPARE bg_column_stmt FROM @bg_column_sql;
    EXECUTE bg_column_stmt;
    DEALLOCATE PREPARE bg_column_stmt;
  END IF;
END;

--> statement-breakpoint

CALL `__bg_ensure_column`(
  'execution_resource_queue',
  'status',
  "varchar(20) NOT NULL DEFAULT 'waiting'"
);

--> statement-breakpoint

CALL `__bg_ensure_index`(
  'execution_resource_queue',
  'idx_execution_resource_queue_resource_status',
  '`resource_key`, `status`'
);

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'execution_id', 'varchar(100)');

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'fencing_token', 'bigint');

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'resource_wait_key', 'varchar(255)');

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'resource_wait_id', 'bigint');

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'resource_wait_position', 'int');

--> statement-breakpoint

CALL `__bg_ensure_column`('tarefas', 'paused_at', 'timestamp NULL');

--> statement-breakpoint

CALL `__bg_ensure_index`(
  'tarefas',
  'idx_tarefas_resource_wait',
  '`status`, `resource_wait_key`'
);

--> statement-breakpoint

DROP PROCEDURE `__bg_ensure_index`;

--> statement-breakpoint

DROP PROCEDURE `__bg_ensure_column`;
