CREATE TABLE `voz_configuracoes` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`escopo` varchar(100) NOT NULL,
	`voz` varchar(100) NOT NULL DEFAULT 'isadora',
	`idioma` varchar(10) NOT NULL DEFAULT 'pt-BR',
	`ativa` boolean NOT NULL DEFAULT false,
	`observacoes` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `voz_configuracoes_id` PRIMARY KEY(`id`),
	CONSTRAINT `voz_configuracoes_escopo_unico` UNIQUE(`escopo`)
);
