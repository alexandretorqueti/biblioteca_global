-- Fila durável para tarefas prontas, mas sem capacidade de desenvolvimento.
-- A liberação de uma vaga publica nova mensagem; não há pump/polling decisório.
CREATE TABLE IF NOT EXISTS `motor_execution_wait_queue` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `projeto_id` bigint unsigned NOT NULL,
  `source_message_id` varchar(100) NOT NULL,
  `requested_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_woken_at` timestamp NULL,
  `wake_count` int unsigned NOT NULL DEFAULT 0,
  `status` enum('waiting','cancelled') NOT NULL DEFAULT 'waiting',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `motor_execution_wait_queue_id` PRIMARY KEY (`id`),
  CONSTRAINT `motor_execution_wait_queue_tarefa_unique` UNIQUE (`tarefa_id`),
  CONSTRAINT `motor_execution_wait_queue_tarefa_fk`
    FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE CASCADE,
  CONSTRAINT `motor_execution_wait_queue_projeto_fk`
    FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE CASCADE,
  INDEX `idx_motor_execution_wait_queue_status_requested` (`status`, `requested_at`)
);
