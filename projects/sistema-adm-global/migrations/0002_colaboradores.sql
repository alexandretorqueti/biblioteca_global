CREATE TABLE `colaboradores` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome_completo` varchar(200) NOT NULL,
	`cpf` varchar(14) NOT NULL,
	`rg` varchar(20),
	`email` varchar(200) NOT NULL,
	`telefone` varchar(30) NOT NULL,
	`data_nascimento` varchar(10) NOT NULL,
	`cargo` varchar(100) NOT NULL,
	`departamento_id` bigint unsigned,
	`data_admissao` varchar(10) NOT NULL,
	`tipo_vinculo` enum('clt','pj','estagio','temporario','apprentiz') NOT NULL DEFAULT 'clt',
	`logradouro` varchar(200),
	`numero` varchar(20),
	`complemento` varchar(100),
	`bairro` varchar(100),
	`cidade` varchar(100),
	`uf` varchar(2),
	`cep` varchar(10),
	`contato_emergencia_nome` varchar(200),
	`contato_emergencia_telefone` varchar(30),
	`ativo` tinyint(1) NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `colaboradores_id` PRIMARY KEY(`id`),
	CONSTRAINT `colaboradores_cpf_unique` UNIQUE(`cpf`)
);
--> statement-breakpoint
ALTER TABLE `colaboradores` ADD CONSTRAINT `colaboradores_departamento_id_departamentos_id_fk` FOREIGN KEY (`departamento_id`) REFERENCES `departamentos`(`id`) ON DELETE set null;
