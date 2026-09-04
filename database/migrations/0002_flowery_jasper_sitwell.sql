CREATE TABLE `helpdesk_mensagens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sessao_id` bigint unsigned NOT NULL,
	`role` enum('agent','user','system') NOT NULL,
	`text` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `helpdesk_mensagens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `helpdesk_sessoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`agente_id` varchar(100) NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `helpdesk_sessoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `projetos` ADD `branch_trabalho` varchar(255);--> statement-breakpoint
ALTER TABLE `projetos` ADD `repo_path` varchar(500);--> statement-breakpoint
ALTER TABLE `projetos` ADD `agente_id` varchar(100);--> statement-breakpoint
ALTER TABLE `helpdesk_mensagens` ADD CONSTRAINT `helpdesk_mensagens_sessao_id_helpdesk_sessoes_id_fk` FOREIGN KEY (`sessao_id`) REFERENCES `helpdesk_sessoes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `helpdesk_sessoes` ADD CONSTRAINT `helpdesk_sessoes_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `helpdesk_sessoes` ADD CONSTRAINT `helpdesk_sessoes_projeto_id_projetos_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_helpdesk_mensagens_sessao` ON `helpdesk_mensagens` (`sessao_id`);--> statement-breakpoint
CREATE INDEX `idx_helpdesk_sessoes_usuario` ON `helpdesk_sessoes` (`usuario_id`);--> statement-breakpoint
CREATE INDEX `idx_helpdesk_sessoes_projeto` ON `helpdesk_sessoes` (`projeto_id`);