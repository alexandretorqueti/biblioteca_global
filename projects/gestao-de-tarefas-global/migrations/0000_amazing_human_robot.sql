CREATE TABLE `anexos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`enviado_por_id` bigint unsigned NOT NULL,
	`nome` varchar(255) NOT NULL,
	`tipo` varchar(120) NOT NULL,
	`url` varchar(1000) NOT NULL,
	`tamanho_bytes` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `anexos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `areas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(150) NOT NULL,
	`descricao` text,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `areas_id` PRIMARY KEY(`id`),
	CONSTRAINT `areas_nome_unique` UNIQUE(`nome`)
);
--> statement-breakpoint
CREATE TABLE `atribuicoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`responsavel_id` bigint unsigned NOT NULL,
	`atribuido_por_id` bigint unsigned NOT NULL,
	`resposta` enum('pendente','concluida','mais_informacoes','aguardando_outra_pessoa') NOT NULL DEFAULT 'pendente',
	`observacoes` text,
	`iniciado_em` timestamp,
	`respondido_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `atribuicoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `comentarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`autor_id` bigint unsigned NOT NULL,
	`conteudo` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `comentarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `historico_tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`autor_id` bigint unsigned NOT NULL,
	`evento` varchar(100) NOT NULL,
	`detalhes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `historico_tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lembretes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`canal` enum('site','email') NOT NULL,
	`notificar_em` timestamp NOT NULL,
	`enviado_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lembretes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recorrencias` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`descricao` varchar(200) NOT NULL,
	`frequencia` enum('diaria','semanal','mensal','personalizada') NOT NULL,
	`regra` varchar(200) NOT NULL,
	`proxima_execucao` timestamp,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recorrencias_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(100) NOT NULL,
	`cor` varchar(20),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `tags_nome_unique` UNIQUE(`nome`)
);
--> statement-breakpoint
CREATE TABLE `tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`area_id` bigint unsigned NOT NULL,
	`recorrencia_id` bigint unsigned,
	`criado_por_id` bigint unsigned NOT NULL,
	`titulo` varchar(240) NOT NULL,
	`descricao` text,
	`status` enum('aberta','em_andamento','aguardando','concluida','cancelada') NOT NULL DEFAULT 'aberta',
	`prioridade` enum('baixa','normal','alta','urgente') NOT NULL DEFAULT 'normal',
	`prazo` timestamp,
	`concluida_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tarefas_tags` (
	`tarefa_id` bigint unsigned NOT NULL,
	`tag_id` bigint unsigned NOT NULL,
	CONSTRAINT `tarefas_tags_tarefa_id_tag_id_pk` PRIMARY KEY(`tarefa_id`,`tag_id`)
);
--> statement-breakpoint
ALTER TABLE `anexos` ADD CONSTRAINT `anexos_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `atribuicoes` ADD CONSTRAINT `atribuicoes_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `comentarios` ADD CONSTRAINT `comentarios_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `historico_tarefas` ADD CONSTRAINT `historico_tarefas_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `lembretes` ADD CONSTRAINT `lembretes_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_area_id_areas_id_fk` FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_recorrencia_id_recorrencias_id_fk` FOREIGN KEY (`recorrencia_id`) REFERENCES `recorrencias`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas_tags` ADD CONSTRAINT `tarefas_tags_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tarefas_tags` ADD CONSTRAINT `tarefas_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `anexos_tarefa_idx` ON `anexos` (`tarefa_id`);--> statement-breakpoint
CREATE INDEX `atribuicoes_tarefa_idx` ON `atribuicoes` (`tarefa_id`);--> statement-breakpoint
CREATE INDEX `atribuicoes_responsavel_idx` ON `atribuicoes` (`responsavel_id`);--> statement-breakpoint
CREATE INDEX `comentarios_tarefa_idx` ON `comentarios` (`tarefa_id`);--> statement-breakpoint
CREATE INDEX `historico_tarefas_tarefa_idx` ON `historico_tarefas` (`tarefa_id`);--> statement-breakpoint
CREATE INDEX `lembretes_pendentes_idx` ON `lembretes` (`notificar_em`,`enviado_em`);--> statement-breakpoint
CREATE INDEX `tarefas_area_idx` ON `tarefas` (`area_id`);--> statement-breakpoint
CREATE INDEX `tarefas_status_prazo_idx` ON `tarefas` (`status`,`prazo`);