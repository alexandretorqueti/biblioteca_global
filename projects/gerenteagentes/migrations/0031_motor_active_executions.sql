-- Presença persistente dos workers do Motor. Não representa exclusividade:
-- várias execuções do mesmo projeto podem coexistir. O reconciliador usa o
-- heartbeat/expiração desta tabela para distinguir worker ativo de órfão.
CREATE TABLE IF NOT EXISTS `motor_active_executions` (
  `execution_id` varchar(200) NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `subtarefa_id` bigint unsigned NULL,
  `phase` varchar(20) NOT NULL,
  `started_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `heartbeat_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` timestamp NOT NULL,
  CONSTRAINT `motor_active_executions_pk` PRIMARY KEY (`execution_id`),
  CONSTRAINT `motor_active_executions_task_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `motor_active_executions_subtask_fk` FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas` (`id`) ON DELETE CASCADE,
  KEY `motor_active_executions_task_expiry_idx` (`tarefa_id`, `expires_at`),
  KEY `motor_active_executions_subtask_expiry_idx` (`subtarefa_id`, `expires_at`)
);
