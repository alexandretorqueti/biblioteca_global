CREATE TABLE `indices` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(100) NOT NULL,
	`sigla` varchar(20) NOT NULL,
	`taxa_anual` decimal(9,4) NOT NULL DEFAULT '0',
	`fonte_cotacao` varchar(100) NOT NULL DEFAULT 'Banco Central (SGS)',
	`ordem` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `indices_id` PRIMARY KEY(`id`),
	CONSTRAINT `indices_nome_unico` UNIQUE(`nome`),
	CONSTRAINT `indices_sigla_unica` UNIQUE(`sigla`)
);
