-- Histórico auditável de cada tentativa de modelo do Motor.
-- Diferente de logs, estes registros ficam vinculados à tarefa/subtarefa e
-- permitem reconstruir a escada usada, o motivo da troca e as repetições.
CREATE TABLE IF NOT EXISTS `analysis_attempt` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tarefa_id` bigint unsigned NOT NULL,
  `subtarefa_id` bigint unsigned NULL,
  `fase` varchar(30) NOT NULL,
  `modelo` varchar(191) NOT NULL,
  `tier` int unsigned NOT NULL,
  `tentativa` int unsigned NOT NULL,
  `repeticoes` int unsigned NOT NULL DEFAULT 0,
  `motivo` text NULL,
  `custo_estimado` decimal(12,6) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `analysis_attempt_pk` PRIMARY KEY (`id`),
  CONSTRAINT `analysis_attempt_task_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `analysis_attempt_subtask_fk` FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas` (`id`) ON DELETE SET NULL,
  KEY `analysis_attempt_task_created_idx` (`tarefa_id`, `created_at`),
  KEY `analysis_attempt_model_created_idx` (`modelo`, `created_at`)
);
