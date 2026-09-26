SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `projetos_captados` ADD `branch_trabalho` varchar(255)',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'projetos_captados'
    AND column_name = 'branch_trabalho'
);--> statement-breakpoint

PREPARE stmt FROM @sql;--> statement-breakpoint
EXECUTE stmt;--> statement-breakpoint
DEALLOCATE PREPARE stmt;--> statement-breakpoint
SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `tarefas` ADD `external_id` varchar(64)',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'tarefas'
    AND column_name = 'external_id'
);--> statement-breakpoint

PREPARE stmt FROM @sql;--> statement-breakpoint
EXECUTE stmt;--> statement-breakpoint
DEALLOCATE PREPARE stmt;--> statement-breakpoint

SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_external_id_unique` UNIQUE(`external_id`)',
    'SELECT 1'
  )
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'tarefas'
    AND constraint_name = 'tarefas_external_id_unique'
    AND constraint_type = 'UNIQUE'
);--> statement-breakpoint

PREPARE stmt FROM @sql;--> statement-breakpoint
EXECUTE stmt;--> statement-breakpoint
DEALLOCATE PREPARE stmt;
