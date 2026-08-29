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

CREATE INDEX `idx_execution_resources_expires_at` ON `execution_resources` (`expires_at`);

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

CREATE INDEX `idx_execution_resource_queue_resource_status` ON `execution_resource_queue` (`resource_key`, `status`);

--> statement-breakpoint

ALTER TABLE `tarefas`
  ADD COLUMN `execution_id` varchar(100),
  ADD COLUMN `fencing_token` bigint,
  ADD COLUMN `resource_wait_key` varchar(255),
  ADD COLUMN `resource_wait_id` bigint,
  ADD COLUMN `resource_wait_position` int,
  ADD COLUMN `paused_at` timestamp NULL;

--> statement-breakpoint

CREATE INDEX `idx_tarefas_resource_wait` ON `tarefas` (`status`, `resource_wait_key`);
