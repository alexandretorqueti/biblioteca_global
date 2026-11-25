ALTER TABLE `tarefas` DROP FOREIGN KEY `tarefas_regra_recorrencia_id_regras_recorrencia_id_fk`;
--> statement-breakpoint
ALTER TABLE `tarefas` ADD CONSTRAINT `tarefas_regra_recorrencia_id_regras_recorrencia_id_fk` FOREIGN KEY (`regra_recorrencia_id`) REFERENCES `regras_recorrencia`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `regras_recorrencia_ativa_proxima_geracao` ON `regras_recorrencia` (`ativa`,`proxima_geracao`);
