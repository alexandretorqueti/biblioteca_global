CREATE TABLE `negocio_documentos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`negocio_id` bigint unsigned NOT NULL,
	`nome` varchar(255) NOT NULL,
	`mime` varchar(100) NOT NULL,
	`tamanho` int unsigned NOT NULL,
	`caminho` varchar(1000) NOT NULL,
	`uso_diferido` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `negocio_documentos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `negocios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`chat_id` varchar(255) NOT NULL,
	`nome` varchar(255) NOT NULL,
	`segmento_descricao` varchar(2000) NOT NULL,
	`contato` json NOT NULL,
	`transbordo` json NOT NULL,
	`status` enum('capturado','aguardando_plano','checkout','pago','provisionando','provisionado','falho') NOT NULL DEFAULT 'capturado',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `negocios_id` PRIMARY KEY(`id`),
	CONSTRAINT `negocios_chat_id_unique` UNIQUE(`chat_id`)
);
--> statement-breakpoint
CREATE TABLE `pedidos_venda` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`negocio_id` bigint unsigned NOT NULL,
	`plano_slug` varchar(100) NOT NULL,
	`checkout_url` varchar(2000),
	`assinatura_id` bigint unsigned,
	`payload_snapshot` json NOT NULL,
	`status` enum('pending','paid','provisioning','provisioned','failed','refunded') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pedidos_venda_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `negocio_documentos` ADD CONSTRAINT `negocio_documentos_negocio_id_negocios_id_fk` FOREIGN KEY (`negocio_id`) REFERENCES `negocios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedidos_venda` ADD CONSTRAINT `pedidos_venda_negocio_id_negocios_id_fk` FOREIGN KEY (`negocio_id`) REFERENCES `negocios`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedidos_venda` ADD CONSTRAINT `pedidos_venda_assinatura_id_assinaturas_id_fk` FOREIGN KEY (`assinatura_id`) REFERENCES `assinaturas`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_negocio_documentos_negocio` ON `negocio_documentos` (`negocio_id`);--> statement-breakpoint
CREATE INDEX `idx_pedidos_venda_negocio` ON `pedidos_venda` (`negocio_id`);--> statement-breakpoint
CREATE INDEX `idx_pedidos_venda_assinatura` ON `pedidos_venda` (`assinatura_id`);