CREATE TABLE `entregas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`encomenda_id` bigint unsigned NOT NULL,
	`funcionario_id` bigint unsigned NOT NULL,
	`data_hora_entrega` timestamp NOT NULL DEFAULT (now()),
	`evidencia_quem_retirou` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `entregas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `entregas` ADD CONSTRAINT `entregas_encomenda_id_encomendas_id_fk` FOREIGN KEY (`encomenda_id`) REFERENCES `encomendas`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entregas` ADD CONSTRAINT `entregas_funcionario_id_funcionarios_id_fk` FOREIGN KEY (`funcionario_id`) REFERENCES `funcionarios`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_entregas_encomenda_id` ON `entregas` (`encomenda_id`);--> statement-breakpoint
CREATE INDEX `idx_entregas_funcionario_id` ON `entregas` (`funcionario_id`);