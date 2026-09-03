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
ALTER TABLE `projetos_captados` ADD COLUMN IF NOT EXISTS `agente_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `subtarefas_entregas` ADD CONSTRAINT `subtarefas_entregas_subtarefa_id_subtarefas_id_fk` FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projetos_captados` ADD CONSTRAINT `projetos_captados_agente_id_agentes_id_fk` FOREIGN KEY (`agente_id`) REFERENCES `agentes`(`id`) ON DELETE set null ON UPDATE no action;