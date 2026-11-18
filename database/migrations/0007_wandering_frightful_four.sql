CREATE TABLE `planos_produto` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(100) NOT NULL,
	`nome` varchar(150) NOT NULL,
	`preco_centavos` int unsigned NOT NULL,
	`moeda` varchar(3) NOT NULL DEFAULT 'BRL',
	`ciclo` enum('monthly','yearly') NOT NULL,
	`limites_cotas` json NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `planos_produto_id` PRIMARY KEY(`id`),
	CONSTRAINT `planos_produto_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `assinaturas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned,
	`tenant_slug` varchar(64) NOT NULL,
	`plano_produto_id` bigint unsigned NOT NULL,
	`status` enum('pending','active','past_due','canceled','expired') NOT NULL DEFAULT 'pending',
	`ciclo` enum('monthly','yearly') NOT NULL,
	`psp_customer_id` varchar(255),
	`psp_subscription_id` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `assinaturas_id` PRIMARY KEY(`id`),
	CONSTRAINT `assinaturas_psp_subscription_id_unique` UNIQUE(`psp_subscription_id`)
);
--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`dedupe_key` varchar(512) NOT NULL,
	`tipo` varchar(100) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','processing','done','failed','dead') NOT NULL DEFAULT 'pending',
	`tentativas` int unsigned NOT NULL DEFAULT 0,
	`proxima_tentativa_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_webhook_events_dedupe_key_unique` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `provisionamento_pendente` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`assinatura_id` bigint unsigned NOT NULL,
	`tipo` varchar(100) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','processing','done','failed','dead') NOT NULL DEFAULT 'pending',
	`tentativas` int unsigned NOT NULL DEFAULT 0,
	`ciclo` varchar(100) NOT NULL,
	`proxima_tentativa_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `provisionamento_pendente_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_provisionamento_pendente_assinatura_tipo_ciclo` UNIQUE(`assinatura_id`,`tipo`,`ciclo`)
);
--> statement-breakpoint
ALTER TABLE `assinaturas` ADD CONSTRAINT `assinaturas_plano_produto_id_planos_produto_id_fk`
	FOREIGN KEY (`plano_produto_id`) REFERENCES `planos_produto`(`id`)
	ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `provisionamento_pendente` ADD CONSTRAINT `provisionamento_pendente_assinatura_id_assinaturas_id_fk`
	FOREIGN KEY (`assinatura_id`) REFERENCES `assinaturas`(`id`)
	ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_assinaturas_tenant_id` ON `assinaturas` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX `idx_assinaturas_tenant_slug` ON `assinaturas` (`tenant_slug`);
--> statement-breakpoint
CREATE INDEX `idx_assinaturas_status` ON `assinaturas` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_billing_webhook_events_status_retry` ON `billing_webhook_events` (`status`,`proxima_tentativa_em`);
--> statement-breakpoint
CREATE INDEX `idx_provisionamento_pendente_status_retry` ON `provisionamento_pendente` (`status`,`proxima_tentativa_em`);
