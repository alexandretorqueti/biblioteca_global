CREATE TABLE `tenant_conversa_mensagens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`conversa_id` bigint unsigned NOT NULL,
	`role` enum('visitante','agente','sistema') NOT NULL,
	`texto` text NOT NULL,
	`criada_em` timestamp NOT NULL,
	CONSTRAINT `tenant_conversa_mensagens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tenant_conversas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`external_id` varchar(255) NOT NULL,
	`canal` enum('web','whatsapp') NOT NULL,
	`visitante_key` varchar(255) NOT NULL,
	`contato_nome` varchar(255),
	`contato_email` varchar(320),
	`tema` varchar(255),
	`status` enum('ativa','finalizada','transbordada') NOT NULL,
	`primeira_mensagem_em` timestamp NOT NULL,
	`ultima_mensagem_em` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenant_conversas_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_conversas_tenant_external` UNIQUE(`tenant_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `tenant_cota_alertas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`mes_competencia` char(7) NOT NULL,
	`enviado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tenant_cota_alertas_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_cota_alertas_tenant_mes` UNIQUE(`tenant_id`,`mes_competencia`)
);
--> statement-breakpoint
CREATE TABLE `tenant_leads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`conversa_id` bigint unsigned,
	`ferramenta` varchar(100) NOT NULL,
	`dados_json` json NOT NULL,
	`external_id` varchar(255),
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tenant_leads_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_leads_tenant_external` UNIQUE(`tenant_id`,`external_id`)
);
--> statement-breakpoint
ALTER TABLE `tenants` ADD `retencao_conversas_dias` int unsigned;--> statement-breakpoint
ALTER TABLE `tenant_conversa_mensagens` ADD CONSTRAINT `tenant_conversa_mensagens_conversa_id_tenant_conversas_id_fk` FOREIGN KEY (`conversa_id`) REFERENCES `tenant_conversas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_conversas` ADD CONSTRAINT `tenant_conversas_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_cota_alertas` ADD CONSTRAINT `tenant_cota_alertas_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_leads` ADD CONSTRAINT `tenant_leads_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenant_leads` ADD CONSTRAINT `tenant_leads_conversa_id_tenant_conversas_id_fk` FOREIGN KEY (`conversa_id`) REFERENCES `tenant_conversas`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_tenant_conversa_mensagens_conversa_criada` ON `tenant_conversa_mensagens` (`conversa_id`,`criada_em`);--> statement-breakpoint
CREATE INDEX `idx_tenant_conversas_tenant_id` ON `tenant_conversas` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_conversas_tenant_ultima` ON `tenant_conversas` (`tenant_id`,`ultima_mensagem_em`);--> statement-breakpoint
CREATE INDEX `idx_tenant_conversas_tenant_created` ON `tenant_conversas` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tenant_leads_tenant_id` ON `tenant_leads` (`tenant_id`);
