SET @sql = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `projetos_captados` ADD `repo_path` varchar(500)',
    'SELECT 1'
  )
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'projetos_captados'
    AND column_name = 'repo_path'
);--> statement-breakpoint

PREPARE stmt FROM @sql;--> statement-breakpoint
EXECUTE stmt;--> statement-breakpoint
DEALLOCATE PREPARE stmt;
