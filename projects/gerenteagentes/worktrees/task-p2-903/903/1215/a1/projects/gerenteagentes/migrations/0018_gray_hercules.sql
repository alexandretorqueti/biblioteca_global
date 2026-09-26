CREATE PROCEDURE `bg_migration_0018`()
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = DATABASE()
		  AND table_name = 'tarefas'
		  AND column_name = 'tipo'
	) THEN
		ALTER TABLE `tarefas`
			ADD `tipo` enum('desenvolvimento','automacao','verificacao')
			DEFAULT 'desenvolvimento' NOT NULL;
	END IF;
END;
--> statement-breakpoint
CALL `bg_migration_0018`();
--> statement-breakpoint
DROP PROCEDURE `bg_migration_0018`;
