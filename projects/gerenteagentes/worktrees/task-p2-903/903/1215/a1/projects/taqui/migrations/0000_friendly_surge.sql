CREATE TABLE `condominios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`endereco` varchar(500) NOT NULL,
	`tipo` enum('vertical','horizontal') NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `condominios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `encomendas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`condominio_id` bigint unsigned NOT NULL,
	`unidade_id` bigint unsigned NOT NULL,
	`transportadora_id` bigint unsigned,
	`registrado_por_id` bigint unsigned NOT NULL,
	`codigo_rastreamento` varchar(100),
	`foto_url` varchar(1000),
	`observacoes` text,
	`status` enum('pendente','confirmada','entregue','cancelada') NOT NULL DEFAULT 'pendente',
	`confirmado_por_id` bigint unsigned,
	`confirmado_em` timestamp,
	`entregue_por_id` bigint unsigned,
	`entregue_em` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `encomendas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `funcionarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`condominio_id` bigint unsigned NOT NULL,
	`nome` varchar(200) NOT NULL,
	`funcao` enum('triagem','portaria','ambos') NOT NULL,
	`email` varchar(200),
	`telefone` varchar(50),
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `funcionarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `moradores` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`unidade_id` bigint unsigned NOT NULL,
	`nome` varchar(200) NOT NULL,
	`email` varchar(200),
	`telefone` varchar(50),
	`cpf` varchar(14),
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `moradores_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notificacoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`morador_id` bigint unsigned NOT NULL,
	`encomenda_id` bigint unsigned NOT NULL,
	`tipo` enum('encomenda_pendente','encomenda_confirmada','encomenda_entregue') NOT NULL,
	`mensagem` varchar(500) NOT NULL,
	`lida` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notificacoes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `proprietarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`email` varchar(200),
	`telefone` varchar(50),
	`cpf` varchar(14),
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proprietarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transportadoras` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`cnpj` varchar(18),
	`telefone` varchar(50),
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `transportadoras_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unidades` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`condominio_id` bigint unsigned NOT NULL,
	`tipo` enum('apartamento','casa') NOT NULL,
	`rua` varchar(200),
	`bloco` varchar(50),
	`andar` int,
	`numero` varchar(20),
	`quadra` varchar(50),
	`lote` varchar(50),
	`label` varchar(300),
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `unidades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unidades_proprietarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`unidade_id` bigint unsigned NOT NULL,
	`proprietario_id` bigint unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `unidades_proprietarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_condominio_id_condominios_id_fk` FOREIGN KEY (`condominio_id`) REFERENCES `condominios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_unidade_id_unidades_id_fk` FOREIGN KEY (`unidade_id`) REFERENCES `unidades`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_transportadora_id_transportadoras_id_fk` FOREIGN KEY (`transportadora_id`) REFERENCES `transportadoras`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_registrado_por_id_funcionarios_id_fk` FOREIGN KEY (`registrado_por_id`) REFERENCES `funcionarios`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_confirmado_por_id_moradores_id_fk` FOREIGN KEY (`confirmado_por_id`) REFERENCES `moradores`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `encomendas` ADD CONSTRAINT `encomendas_entregue_por_id_funcionarios_id_fk` FOREIGN KEY (`entregue_por_id`) REFERENCES `funcionarios`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `funcionarios` ADD CONSTRAINT `funcionarios_condominio_id_condominios_id_fk` FOREIGN KEY (`condominio_id`) REFERENCES `condominios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `moradores` ADD CONSTRAINT `moradores_unidade_id_unidades_id_fk` FOREIGN KEY (`unidade_id`) REFERENCES `unidades`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificacoes` ADD CONSTRAINT `notificacoes_morador_id_moradores_id_fk` FOREIGN KEY (`morador_id`) REFERENCES `moradores`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificacoes` ADD CONSTRAINT `notificacoes_encomenda_id_encomendas_id_fk` FOREIGN KEY (`encomenda_id`) REFERENCES `encomendas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unidades` ADD CONSTRAINT `unidades_condominio_id_condominios_id_fk` FOREIGN KEY (`condominio_id`) REFERENCES `condominios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unidades_proprietarios` ADD CONSTRAINT `unidades_proprietarios_unidade_id_unidades_id_fk` FOREIGN KEY (`unidade_id`) REFERENCES `unidades`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `unidades_proprietarios` ADD CONSTRAINT `unidades_proprietarios_proprietario_id_proprietarios_id_fk` FOREIGN KEY (`proprietario_id`) REFERENCES `proprietarios`(`id`) ON DELETE cascade ON UPDATE no action;