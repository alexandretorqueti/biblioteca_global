CREATE TABLE IF NOT EXISTS `subtarefas_entregas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`subtarefa_id` bigint unsigned NOT NULL,
	`deliver_number` int NOT NULL,
	`model` varchar(100),
	`event_type` varchar(50) NOT NULL,
	`reason` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `subtarefas_entregas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE PROCEDURE `bg_migration_0017`()
BEGIN
	/* MySQL não aceita ADD COLUMN IF NOT EXISTS. A coluna e a FK são
	 * legadas e só devem ser recriadas quando o schema antigo ainda existir. */
	IF EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name = 'agentes'
	) THEN
		IF NOT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = DATABASE()
			  AND table_name = 'projetos_captados'
			  AND column_name = 'agente_id'
		) THEN
			ALTER TABLE `projetos_captados` ADD `agente_id` bigint unsigned;
		END IF;

		IF NOT EXISTS (
			SELECT 1 FROM information_schema.table_constraints
			WHERE constraint_schema = DATABASE()
			  AND table_name = 'projetos_captados'
			  AND constraint_name = 'projetos_captados_agente_id_agentes_id_fk'
		) THEN
			ALTER TABLE `projetos_captados`
				ADD CONSTRAINT `projetos_captados_agente_id_agentes_id_fk`
				FOREIGN KEY (`agente_id`) REFERENCES `agentes`(`id`)
				ON DELETE set null ON UPDATE no action;
		END IF;
	END IF;
END;
--> statement-breakpoint
CALL `bg_migration_0017`();
--> statement-breakpoint
DROP PROCEDURE `bg_migration_0017`;
