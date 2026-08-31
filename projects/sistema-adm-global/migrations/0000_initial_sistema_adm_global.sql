CREATE TABLE `usuarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`email` varchar(200) NOT NULL,
	`papel` enum('admin','usuario') NOT NULL DEFAULT 'usuario',
	`ativo` tinyint(1) NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usuarios_id` PRIMARY KEY(`id`),
	CONSTRAINT `usuarios_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `clientes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome_fantasia` varchar(200) NOT NULL,
	`razao_social` varchar(300) NOT NULL,
	`cnpj` varchar(18) NOT NULL,
	`inscricao_municipal` varchar(50),
	`inscricao_estadual` varchar(50),
	`logradouro` varchar(200) NOT NULL,
	`numero` varchar(20) NOT NULL,
	`complemento` varchar(100),
	`bairro` varchar(100) NOT NULL,
	`cidade` varchar(100) NOT NULL,
	`uf` varchar(2) NOT NULL,
	`cep` varchar(10) NOT NULL,
	`telefone` varchar(30) NOT NULL,
	`ramal` varchar(10),
	`email` varchar(200) NOT NULL,
	`ativo` tinyint(1) NOT NULL DEFAULT 1,
	`administrador_id` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `clientes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `responsaveis` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`cliente_id` bigint unsigned NOT NULL,
	`nome` varchar(200) NOT NULL,
	`cargo` varchar(100),
	`telefone` varchar(30),
	`email` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `responsaveis_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contratos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`cliente_id` bigint unsigned NOT NULL,
	`numero` varchar(50) NOT NULL,
	`descricao` text,
	`valor` varchar(30),
	`inicio` varchar(10),
	`fim` varchar(10),
	`ativo` tinyint(1) NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contratos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contatos_site` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`email` varchar(200) NOT NULL,
	`telefone` varchar(30),
	`assunto` varchar(200) NOT NULL,
	`mensagem` text NOT NULL,
	`data_envio` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contatos_site_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `circulares` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`titulo` varchar(200) NOT NULL,
	`image_url` varchar(500),
	`conteudo` text NOT NULL,
	`publicado_em` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `circulares_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `departamentos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(50) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `departamentos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `config_empresa` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(200) NOT NULL,
	`logo_url` varchar(500),
	`endereco` varchar(300),
	`cnpj` varchar(18),
	`telefone` varchar(30),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `config_empresa_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `clientes` ADD CONSTRAINT `clientes_administrador_id_usuarios_id_fk` FOREIGN KEY (`administrador_id`) REFERENCES `usuarios`(`id`) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD CONSTRAINT `responsaveis_cliente_id_clientes_id_fk` FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `contratos` ADD CONSTRAINT `contratos_cliente_id_clientes_id_fk` FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON DELETE cascade;
