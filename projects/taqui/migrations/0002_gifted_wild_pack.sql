CREATE TABLE `ocorrencias` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`encomenda_id` bigint unsigned NOT NULL,
	`condominio_id` bigint unsigned NOT NULL,
	`registrado_por_id` bigint unsigned NOT NULL,
	`tipo` enum('devolucao_transportadora','extravio','recusada','endereco_incorreto','outro') NOT NULL,
	`motivo` varchar(2000) NOT NULL,
	`descricao` text,
	`foto_evidencia_url` varchar(1000),
	`observacoes` text,
	`devolvida_transportadora` boolean NOT NULL DEFAULT false,
	`data_ocorrencia` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocorrencias_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `encomendas` ADD `cancelado_por_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `encomendas` ADD `cancelado_em` timestamp;--> statement-breakpoint
ALTER TABLE `encomendas` ADD `motivo_cancelamento` varchar(500);--> statement-breakpoint
ALTER TABLE `entregas` ADD `condominio_id` bigint unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `ocorrencias` ADD CONSTRAINT `ocorrencias_encomenda_id_encomendas_id_fk` FOREIGN KEY (`encomenda_id`) REFERENCES `encomendas`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ocorrencias` ADD CONSTRAINT `ocorrencias_condominio_id_condominios_id_fk` FOREIGN KEY (`condominio_id`) REFERENCES `condominios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ocorrencias` ADD CONSTRAINT `ocorrencias_registrado_por_id_funcionarios_id_fk` FOREIGN KEY (`registrado_por_id`) REFERENCES `funcionarios`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ocorrencias_encomenda_id` ON `ocorrencias` (`encomenda_id`);--> statement-breakpoint
CREATE INDEX `idx_ocorrencias_condominio_id` ON `ocorrencias` (`condominio_id`);--> statement-breakpoint
CREATE INDEX `idx_ocorrencias_registrado_por_id` ON `ocorrencias` (`registrado_por_id`);--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_cancelado_por_id_funcionarios_id_fk` FOREIGN KEY (`cancelado_por_id`) REFERENCES `funcionarios`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entregas` ADD CONSTRAINT `entregas_condominio_id_condominios_id_fk` FOREIGN KEY (`condominio_id`) REFERENCES `condominios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_entregas_condominio_id` ON `entregas` (`condominio_id`);