-- Idempotent migration: drop tables if they exist before creation (useful for repeated test runs)
DROP TABLE IF EXISTS `execucoes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tarefas`;
--> statement-breakpoint
DROP TABLE IF EXISTS `agentes`;
--> statement-breakpoint
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
CREATE TABLE `execucoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'pendente',
	`resultado` text,
	`duracao_segundos` int,
	`iniciada_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `execucoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`agente_id` bigint unsigned NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`descricao` text,
	`status` varchar(50) NOT NULL DEFAULT 'pendente',
	`prioridade` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `execucoes` ADD CONSTRAINT `execucoes_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_agente_id_agentes_id_fk` FOREIGN KEY (`agente_id`) REFERENCES `agentes`(`id`) ON DELETE cascade ON UPDATE no action;
