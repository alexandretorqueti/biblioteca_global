CREATE TABLE `email_verifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`chat_id` bigint unsigned NOT NULL,
	`email` varchar(200) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`used` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_resource_queue` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`resource_key` varchar(200) NOT NULL,
	`execution_id` varchar(200) NOT NULL,
	`task_id` varchar(200) NOT NULL,
	`priority` int NOT NULL DEFAULT 0,
	`requested_at` timestamp NOT NULL DEFAULT (now()),
	`status` varchar(20) NOT NULL DEFAULT 'waiting',
	CONSTRAINT `execution_resource_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_resources` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`resource_key` varchar(200) NOT NULL,
	`execution_id` varchar(200) NOT NULL,
	`owner_id` varchar(200) NOT NULL,
	`fencing_token` int NOT NULL DEFAULT 1,
	`heartbeat_at` timestamp NOT NULL,
	`acquired_at` timestamp NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_resources_id` PRIMARY KEY(`id`),
	CONSTRAINT `execution_resources_resource_key_unique` UNIQUE(`resource_key`)
);
--> statement-breakpoint
CREATE TABLE `projeto_model_chain` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`fase` varchar(30) NOT NULL,
	`modelo` varchar(150) NOT NULL,
	`posicao` int NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`is_local` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projeto_model_chain_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projeto_motor_config` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`repo_path` varchar(500) NOT NULL,
	`branch_trabalho` varchar(255) NOT NULL,
	`build_command` varchar(500) NOT NULL,
	`unit_test_command` varchar(500) NOT NULL,
	`unit_test_exclude` json,
	`default_max_rework` int NOT NULL DEFAULT 3,
	`default_hard_timeout_ms` bigint NOT NULL DEFAULT 3600000,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projeto_motor_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `projeto_motor_config_projeto_id_unique` UNIQUE(`projeto_id`)
);
--> statement-breakpoint
CREATE TABLE `visitas_site` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`visitor_key` varchar(255),
	`page_url` varchar(4000),
	`referrer` varchar(4000),
	`user_agent` varchar(2000),
	`ip_hash` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visitas_site_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `correction_for_subtask_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `correction_fingerprint` varchar(500);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `correction_created_at` timestamp;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_path` varchar(1000);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_branch` varchar(255);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_base_commit` varchar(64);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_commit_sha` varchar(64);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_status` varchar(32);--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_created_at` timestamp;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `workspace_cleaned_at` timestamp;--> statement-breakpoint
ALTER TABLE `email_verifications` ADD CONSTRAINT `email_verifications_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projeto_model_chain` ADD CONSTRAINT `projeto_model_chain_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projeto_motor_config` ADD CONSTRAINT `projeto_motor_config_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;