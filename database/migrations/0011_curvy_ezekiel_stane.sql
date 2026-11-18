CREATE TABLE `tenant_tools` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`tool_key` varchar(100) NOT NULL,
	`params_json` json,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenant_tools_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tenant_tools_tenant_tool` UNIQUE(`tenant_id`,`tool_key`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`slug` varchar(100) NOT NULL,
	`nome` varchar(150) NOT NULL,
	`dominio` varchar(255),
	`status` enum('ativo','suspenso','onboarding') NOT NULL DEFAULT 'onboarding',
	`plano` enum('starter','pro','enterprise') NOT NULL DEFAULT 'starter',
	`config_json` json NOT NULL,
	`persona_ref` varchar(255),
	`contatos` json,
	`segredos_ref` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_slug_unique` UNIQUE(`slug`),
	CONSTRAINT `tenants_dominio_unique` UNIQUE(`dominio`)
);
--> statement-breakpoint
ALTER TABLE `assinaturas` MODIFY COLUMN `status` enum('pending','active','past_due','canceled','expired','reembolsavel') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `tenant_tools` ADD CONSTRAINT `tenant_tools_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_tenant_tools_tenant_id` ON `tenant_tools` (`tenant_id`);