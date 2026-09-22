-- Estado durável de clarificação para que a retomada por mensagem não dependa
-- da ordem efêmera do chat.
SET @clarification_pending_column_exists = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'task_runtime_facts'
     AND column_name = 'clarification_pending_at'
);
--> statement-breakpoint
SET @clarification_pending_column_sql = IF(
  @clarification_pending_column_exists = 0,
  'ALTER TABLE task_runtime_facts ADD COLUMN clarification_pending_at timestamp NULL AFTER analysis_execution_id',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE clarification_pending_column_stmt FROM @clarification_pending_column_sql;
--> statement-breakpoint
EXECUTE clarification_pending_column_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE clarification_pending_column_stmt;
