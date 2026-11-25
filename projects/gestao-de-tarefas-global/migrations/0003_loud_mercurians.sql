CREATE INDEX `notificacoes_usuario_id_lida` ON `notificacoes` (`usuario_id`,`lida`);
--> statement-breakpoint
CREATE INDEX `tarefas_prazo_lembrete_antecedencia_minutos` ON `tarefas` (`prazo`,`lembrete_antecedencia_minutos`);
