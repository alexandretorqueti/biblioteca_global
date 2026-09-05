CREATE TABLE `prompts_agentes` (
	`id` bigint unsigned NOT NULL AUTO_INCREMENT,
	`chave` varchar(150) NOT NULL,
	`tipo_agente` varchar(80) NOT NULL,
	`situacao` varchar(100) NOT NULL,
	`conteudo` text NOT NULL,
	`origem` varchar(255) NOT NULL,
	`marcadores` json NOT NULL,
	`ativo` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prompts_agentes_id` PRIMARY KEY(`id`),
	CONSTRAINT `prompts_agentes_chave_unique` UNIQUE(`chave`)
);
