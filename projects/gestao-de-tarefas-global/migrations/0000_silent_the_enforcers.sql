CREATE TABLE `anexos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`nome_arquivo` varchar(255) NOT NULL,
	`mime_type` varchar(120),
	`tamanho_bytes` bigint unsigned,
	`chave_armazenamento` varchar(500) NOT NULL,
	`enviado_por_id` bigint unsigned NOT NULL,
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `anexos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `areas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`nome` varchar(120) NOT NULL,
	`descricao` text,
	`responsavel_id` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `areas_id` PRIMARY KEY(`id`),
	CONSTRAINT `areas_organizacao_id_nome_unique` UNIQUE(`organizacao_id`,`nome`)
);
--> statement-breakpoint
CREATE TABLE `colaboradores` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`nome` varchar(160) NOT NULL,
	`email` varchar(160) NOT NULL,
	`telefone` varchar(20),
	`cpf` char(14),
	`ativo` boolean NOT NULL DEFAULT true,
	`usuario_id` int unsigned,
	CONSTRAINT `colaboradores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `historico_tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`tipo_evento` enum('criacao','delegacao','devolucao_concluida','devolucao_precisa_info','devolucao_aguardando_terceiro','reatribuicao','mudanca_status','mudanca_prazo','mudanca_prioridade','anexo','lembrete_gerado') NOT NULL,
	`de_colaborador_id` bigint unsigned,
	`para_colaborador_id` bigint unsigned,
	`mensagem` text,
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `historico_tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mensagens_tarefa` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`autor_id` bigint unsigned NOT NULL,
	`texto` text NOT NULL,
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mensagens_tarefa_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notificacoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`usuario_id` int unsigned NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`corpo` text,
	`tipo` enum('lembrete','delegacao','devolucao','sistema') NOT NULL,
	`tarefa_id` bigint unsigned,
	`lida` boolean NOT NULL DEFAULT false,
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notificacoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `organizacoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(160) NOT NULL,
	`descricao` text,
	`ativa` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organizacoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `regras_recorrencia` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`descricao` text,
	`area_id` bigint unsigned NOT NULL,
	`responsavel_id` bigint unsigned NOT NULL,
	`frequencia` enum('diaria','semanal','mensal') NOT NULL,
	`dias_semana` json,
	`hora_do_dia` time,
	`data_inicio` date NOT NULL,
	`data_fim` date,
	`ativa` boolean NOT NULL DEFAULT true,
	`proxima_geracao` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `regras_recorrencia_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`nome` varchar(80) NOT NULL,
	CONSTRAINT `tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `tags_organizacao_id_nome_unique` UNIQUE(`organizacao_id`,`nome`)
);
--> statement-breakpoint
CREATE TABLE `tarefa_tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tarefa_id` bigint unsigned NOT NULL,
	`tag_id` bigint unsigned NOT NULL,
	CONSTRAINT `tarefa_tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `tarefa_tags_tarefa_id_tag_id_unique` UNIQUE(`tarefa_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `tarefas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`organizacao_id` bigint unsigned NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`descricao` text,
	`area_id` bigint unsigned NOT NULL,
	`responsavel_id` bigint unsigned NOT NULL,
	`criado_por_id` bigint unsigned NOT NULL,
	`prioridade` enum('baixa','media','alta','urgente') NOT NULL DEFAULT 'media',
	`prazo` datetime,
	`status` enum('aberta','delegada','concluida','precisa_informacoes','aguardando_terceiro','cancelada') NOT NULL DEFAULT 'aberta',
	`lembrete_antecedencia_minutos` int,
	`regra_recorrencia_id` bigint unsigned,
	`concluida_em` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tarefas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `anexos` ADD CONSTRAINT `anexos_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `anexos` ADD CONSTRAINT `anexos_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `anexos` ADD CONSTRAINT `anexos_enviado_por_id_colaboradores_id_fk` FOREIGN KEY (`enviado_por_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `areas` ADD CONSTRAINT `areas_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `areas` ADD CONSTRAINT `areas_responsavel_id_colaboradores_id_fk` FOREIGN KEY (`responsavel_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `colaboradores` ADD CONSTRAINT `colaboradores_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `historico_tarefas` ADD CONSTRAINT `historico_tarefas_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `historico_tarefas` ADD CONSTRAINT `historico_tarefas_de_colaborador_id_colaboradores_id_fk` FOREIGN KEY (`de_colaborador_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `historico_tarefas` ADD CONSTRAINT `historico_tarefas_para_colaborador_id_colaboradores_id_fk` FOREIGN KEY (`para_colaborador_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mensagens_tarefa` ADD CONSTRAINT `mensagens_tarefa_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `mensagens_tarefa` ADD CONSTRAINT `mensagens_tarefa_autor_id_colaboradores_id_fk` FOREIGN KEY (`autor_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `notificacoes` ADD CONSTRAINT `notificacoes_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `notificacoes` ADD CONSTRAINT `notificacoes_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `regras_recorrencia` ADD CONSTRAINT `regras_recorrencia_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `regras_recorrencia` ADD CONSTRAINT `regras_recorrencia_area_id_areas_id_fk` FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `regras_recorrencia` ADD CONSTRAINT `regras_recorrencia_responsavel_id_colaboradores_id_fk` FOREIGN KEY (`responsavel_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `tags_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefa_tags` ADD CONSTRAINT `tarefa_tags_tarefa_id_tarefas_id_fk` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefa_tags` ADD CONSTRAINT `tarefa_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_organizacao_id_organizacoes_id_fk` FOREIGN KEY (`organizacao_id`) REFERENCES `organizacoes`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_area_id_areas_id_fk` FOREIGN KEY (`area_id`) REFERENCES `areas`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_responsavel_id_colaboradores_id_fk` FOREIGN KEY (`responsavel_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_criado_por_id_colaboradores_id_fk` FOREIGN KEY (`criado_por_id`) REFERENCES `colaboradores`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_regra_recorrencia_id_regras_recorrencia_id_fk` FOREIGN KEY (`regra_recorrencia_id`) REFERENCES `regras_recorrencia`(`id`) ON DELETE no action ON UPDATE no action;