-- Fatos operacionais da tarefa. O campo tarefas.status deixa de ser a
-- máquina de estados do Motor; ele é mantido apenas para compatibilidade de
-- registros antigos durante a migração.
CREATE TABLE IF NOT EXISTS `task_runtime_facts` (
  `tarefa_id` bigint unsigned NOT NULL,
  `analysis_started_at` timestamp NULL,
  `integration_confirmed_at` timestamp NULL,
  `terminal_status` varchar(30) NULL,
  `terminal_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `task_runtime_facts_tarefa_id_pk` PRIMARY KEY (`tarefa_id`),
  CONSTRAINT `task_runtime_facts_tarefa_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE CASCADE,
  KEY `task_runtime_facts_analysis_idx` (`analysis_started_at`),
  KEY `task_runtime_facts_terminal_idx` (`terminal_status`)
);

--> statement-breakpoint

SET @bg_bloqueios_resolved_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'bloqueios' AND column_name = 'resolved_at'
);
SET @bg_bloqueios_resolved_sql = IF(
  @bg_bloqueios_resolved_exists = 0,
  'ALTER TABLE `bloqueios` ADD COLUMN `resolved_at` timestamp NULL',
  'SELECT 1'
);
PREPARE bg_stmt FROM @bg_bloqueios_resolved_sql;
EXECUTE bg_stmt;
DEALLOCATE PREPARE bg_stmt;

--> statement-breakpoint

-- O histórico anterior não tinha `resolved_at`. Preserva como ativo somente
-- o bloqueio cuja tarefa ou subtarefa ainda aparece bloqueada no snapshot
-- legado; os demais são histórico já resolvido.
UPDATE `bloqueios` b
INNER JOIN `tarefas` t ON t.id = b.tarefa_id
LEFT JOIN `subtarefas` s ON s.id = b.subtarefa_id
SET b.resolved_at = NOW()
WHERE b.resolved_at IS NULL
  AND t.status <> 'blocked'
  AND (b.subtarefa_id IS NULL OR COALESCE(s.status, 'pending') <> 'blocked');

--> statement-breakpoint

SET @bg_bloqueios_active_index_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'bloqueios' AND index_name = 'bloqueios_active_task_idx'
);
SET @bg_bloqueios_active_index_sql = IF(
  @bg_bloqueios_active_index_exists = 0,
  'CREATE INDEX `bloqueios_active_task_idx` ON `bloqueios` (`tarefa_id`, `resolved_at`)',
  'SELECT 1'
);
PREPARE bg_idx_stmt FROM @bg_bloqueios_active_index_sql;
EXECUTE bg_idx_stmt;
DEALLOCATE PREPARE bg_idx_stmt;
