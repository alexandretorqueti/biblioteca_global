CREATE TABLE `configuracao_sistema` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `configuracao_sistema_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ocorrencias_recorrencias` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`recorrencia_id` bigint unsigned NOT NULL,
	`tarefa_base_id` bigint unsigned,
	`tarefa_gerada_id` bigint unsigned,
	`ocorrencia_em` timestamp NOT NULL,
	`chave` varchar(160) NOT NULL,
	`status` enum('programada','gerada','cancelada') NOT NULL DEFAULT 'programada',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ocorrencias_recorrencias_id` PRIMARY KEY(`id`),
	CONSTRAINT `ocorrencias_recorrencias_chave_unique` UNIQUE(`chave`)
);
--> statement-breakpoint
-- Compatibilidade: a periodicidade legada 'personalizada' é convertida para 'diaria'
-- (regra legada preservada na coluna `regra`) antes de reduzir o enum.
UPDATE `recorrencias` SET `frequencia` = 'diaria' WHERE `frequencia` = 'personalizada';
--> statement-breakpoint
ALTER TABLE `recorrencias` MODIFY COLUMN `frequencia` enum('diaria','semanal','mensal','anual') NOT NULL;
--> statement-breakpoint
ALTER TABLE `recorrencias` MODIFY COLUMN `regra` varchar(200);
--> statement-breakpoint
ALTER TABLE `recorrencias` ADD `hora_execucao` varchar(5) DEFAULT '09:00' NOT NULL;
--> statement-breakpoint
ALTER TABLE `recorrencias` ADD `dias_semana` varchar(20);
--> statement-breakpoint
ALTER TABLE `recorrencias` ADD `dia_mes` smallint;
--> statement-breakpoint
ALTER TABLE `recorrencias` ADD `mes` smallint;
--> statement-breakpoint
ALTER TABLE `ocorrencias_recorrencias` ADD CONSTRAINT `ocorrencias_recorrencias_recorrencia_id_recorrencias_id_fk` FOREIGN KEY (`recorrencia_id`) REFERENCES `recorrencias`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `ocorrencias_recorrencias` ADD CONSTRAINT `ocorrencias_recorrencias_tarefa_base_id_tarefas_id_fk` FOREIGN KEY (`tarefa_base_id`) REFERENCES `tarefas`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `ocorrencias_recorrencias` ADD CONSTRAINT `ocorrencias_recorrencias_tarefa_gerada_id_tarefas_id_fk` FOREIGN KEY (`tarefa_gerada_id`) REFERENCES `tarefas`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `ocorrencias_recorrencia_idx` ON `ocorrencias_recorrencias` (`recorrencia_id`);
--> statement-breakpoint
CREATE INDEX `ocorrencias_pendentes_idx` ON `ocorrencias_recorrencias` (`status`,`ocorrencia_em`);
--> statement-breakpoint
-- Configuração única de timezone do sistema (IANA), referência para todos os
-- cálculos de recorrência e prazos. Validada como IANA no contrato de domínio.
INSERT INTO `configuracao_sistema` (`id`, `timezone`) VALUES (1, 'America/Sao_Paulo');
