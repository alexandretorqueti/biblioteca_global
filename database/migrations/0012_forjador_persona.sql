CREATE TABLE `personas_forjadas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_slug` varchar(64),
	`tenant_id` bigint unsigned,
	`descricao_negocio` text NOT NULL,
	`material_hash` char(64),
	`correlation_id` varchar(100),
	`soul_md` longtext,
	`identity_md` longtext,
	`agents_md` longtext,
	`versao` int unsigned NOT NULL,
	`session_key` varchar(200),
	`status` enum('pending','completed','failed','timeout') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `personas_forjadas_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_personas_forjadas_tenant_slug_versao` UNIQUE(`tenant_slug`,`versao`)
);
--> statement-breakpoint
CREATE INDEX `idx_personas_forjadas_tenant_slug` ON `personas_forjadas` (`tenant_slug`);
--> statement-breakpoint
CREATE INDEX `idx_personas_forjadas_correlation_id` ON `personas_forjadas` (`correlation_id`);