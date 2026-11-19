CREATE TABLE `tenant_canais_whatsapp` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`account_id` varchar(100) NOT NULL,
	`numero` varchar(20),
	`agent_id` varchar(255),
	`estado` enum('pareando','ativo','expirado','removido') NOT NULL DEFAULT 'pareando',
	`ultimo_status_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenant_canais_whatsapp_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_canais_whatsapp_account_id_unique` UNIQUE(`account_id`)
);
--> statement-breakpoint
ALTER TABLE `tenant_canais_whatsapp` ADD CONSTRAINT `tenant_canais_whatsapp_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_tenant_canais_whatsapp_tenant_id` ON `tenant_canais_whatsapp` (`tenant_id`);