CREATE TABLE `deploy_requests` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `repo_path` varchar(1000) NOT NULL,
  `status` enum('pending','running','succeeded','failed') NOT NULL DEFAULT 'pending',
  `batch_id` varchar(100),
  `last_error` text,
  `requested_at` timestamp NOT NULL DEFAULT (now()),
  `started_at` timestamp,
  `finished_at` timestamp,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `deploy_requests_id` PRIMARY KEY(`id`),
  CONSTRAINT `deploy_requests_tarefa_unique` UNIQUE(`tarefa_id`),
  CONSTRAINT `deploy_requests_tarefa_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE CASCADE
);
