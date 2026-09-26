CREATE TABLE `projetos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(150) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`config` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projetos_id` PRIMARY KEY(`id`),
	CONSTRAINT `projetos_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `projetos_usuarios` (
	`projeto_id` bigint unsigned NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`perfil` enum('admin','gerente','operador','visualizador') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `projetos_usuarios_projeto_id_usuario_id_pk` PRIMARY KEY(`projeto_id`,`usuario_id`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`token_hash` varchar(255) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`revoked` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `usuarios` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(100),
	`email` varchar(255),
	`telefone` varchar(30),
	`cpf` varchar(14),
	`password_hash` varchar(255) NOT NULL,
	`nome` varchar(150) NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usuarios_id` PRIMARY KEY(`id`),
	CONSTRAINT `usuarios_username_unique` UNIQUE(`username`),
	CONSTRAINT `usuarios_email_unique` UNIQUE(`email`),
	CONSTRAINT `usuarios_telefone_unique` UNIQUE(`telefone`),
	CONSTRAINT `usuarios_cpf_unique` UNIQUE(`cpf`)
);
--> statement-breakpoint
ALTER TABLE `projetos_usuarios` ADD CONSTRAINT `projetos_usuarios_projeto_id_projetos_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projetos_usuarios` ADD CONSTRAINT `projetos_usuarios_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_refresh_tokens_usuario` ON `refresh_tokens` (`usuario_id`);