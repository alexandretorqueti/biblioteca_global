CREATE TABLE `agentes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(150) NOT NULL,
	`modelo` varchar(100) NOT NULL,
	`descricao` text,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agentes_id` PRIMARY KEY(`id`),
	CONSTRAINT `agentes_nome_unique` UNIQUE(`nome`)
);
--> statement-breakpoint
CREATE TABLE `bloqueios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`block_reason` text,
	`block_command` text,
	`block_exit_code` int,
	`block_excerpt` text,
	`blocked_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bloqueios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_mensagens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`chat_id` bigint unsigned NOT NULL,
	`role` varchar(20) NOT NULL,
	`texto` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `chat_mensagens_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`contato_id` bigint unsigned,
	`projeto_id` bigint unsigned,
	`status` varchar(50) NOT NULL DEFAULT 'aberto',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `chats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contatos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(150),
	`email` varchar(200) NOT NULL,
	`telefone` varchar(50),
	`origem` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contatos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `definicoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`texto` text NOT NULL,
	`seq` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `definicoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `geracoes_projeto` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'pending',
	`session_key` varchar(200),
	`modelo` varchar(100),
	`briefing` text,
	`tarefas_geradas` json,
	`erro` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `geracoes_projeto_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projeto_chats` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`role` varchar(20) NOT NULL,
	`texto` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `projeto_chats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projetos_captados` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`descricao` text,
	`regras` text,
	`contato_id` bigint unsigned,
	`agente_id` bigint unsigned,
	`ativo` boolean NOT NULL DEFAULT true,
	`plataforma_projeto_id` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projetos_captados_id` PRIMARY KEY(`id`),
	CONSTRAINT `projetos_captados_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `subtarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`seq` int NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`descricao` text,
	`status` varchar(50) NOT NULL DEFAULT 'pending',
	`resultado` text,
	`duracao_segundos` int,
	`iniciada_em` timestamp,
	`finalizada_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subtarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tarefa_chats` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`role` varchar(20) NOT NULL,
	`texto` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tarefa_chats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`agente_id` bigint unsigned NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`descricao` text,
	`repo_path` text,
	`build_command` varchar(500),
	`unit_test_command` varchar(500),
	`status` varchar(50) NOT NULL DEFAULT 'draft',
	`max_rework` int NOT NULL DEFAULT 3,
	`hard_timeout_ms` bigint,
	`depends_on_task_id` bigint unsigned,
	`auto_start` boolean NOT NULL DEFAULT false,
	`boot_retry_count` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `bloqueios` ADD CONSTRAINT `bloqueios_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chat_mensagens` ADD CONSTRAINT `chat_mensagens_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chats` ADD CONSTRAINT `chats_contato_id_contatos_id_fk` FOREIGN KEY (`contato_id`) REFERENCES `contatos`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chats` ADD CONSTRAINT `chats_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `definicoes` ADD CONSTRAINT `definicoes_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `geracoes_projeto` ADD CONSTRAINT `geracoes_projeto_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projeto_chats` ADD CONSTRAINT `projeto_chats_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projetos_captados` ADD CONSTRAINT `projetos_captados_contato_id_contatos_id_fk` FOREIGN KEY (`contato_id`) REFERENCES `contatos`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projetos_captados` ADD CONSTRAINT `projetos_captados_agente_id_agentes_id_fk` FOREIGN KEY (`agente_id`) REFERENCES `agentes`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD CONSTRAINT `subtarefas_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefa_chats` ADD CONSTRAINT `tarefa_chats_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_projeto_id_projetos_captados_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_agente_id_agentes_id_fk` FOREIGN KEY (`agente_id`) REFERENCES `agentes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_depends_on_task_id_tarefas_id_fk` FOREIGN KEY (`depends_on_task_id`) REFERENCES `tarefas`(`id`) ON DELETE set null ON UPDATE no action;
