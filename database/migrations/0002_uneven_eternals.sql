CREATE TABLE IF NOT EXISTS `helpdesk_sessoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`agente_id` varchar(100) NOT NULL,
	`status` enum('active','closed') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `helpdesk_sessoes_id` PRIMARY KEY(`id`),
	CONSTRAINT `helpdesk_sessoes_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `helpdesk_sessoes_projeto_id_projetos_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE cascade ON UPDATE no action,
	KEY `idx_helpdesk_sessoes_usuario` (`usuario_id`),
	KEY `idx_helpdesk_sessoes_projeto` (`projeto_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `helpdesk_mensagens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`sessao_id` bigint unsigned NOT NULL,
	`role` enum('agent','user','system') NOT NULL,
	`text` varchar(10000) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `helpdesk_mensagens_id` PRIMARY KEY(`id`),
	CONSTRAINT `helpdesk_mensagens_sessao_id_helpdesk_sessoes_id_fk` FOREIGN KEY (`sessao_id`) REFERENCES `helpdesk_sessoes`(`id`) ON DELETE cascade ON UPDATE no action,
	KEY `idx_helpdesk_mensagens_sessao` (`sessao_id`)
);
--> statement-breakpoint
CREATE PROCEDURE `bg_add_helpdesk_project_columns`()
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'projetos' AND column_name = 'branch_trabalho'
	) THEN
		ALTER TABLE `projetos` ADD `branch_trabalho` varchar(255);
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'projetos' AND column_name = 'repo_path'
	) THEN
		ALTER TABLE `projetos` ADD `repo_path` varchar(500);
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'projetos' AND column_name = 'agente_id'
	) THEN
		ALTER TABLE `projetos` ADD `agente_id` varchar(100);
	END IF;
END;
--> statement-breakpoint
CALL `bg_add_helpdesk_project_columns`();
--> statement-breakpoint
DROP PROCEDURE `bg_add_helpdesk_project_columns`;
