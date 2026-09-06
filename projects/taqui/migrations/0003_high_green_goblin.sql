ALTER TABLE `encomendas` MODIFY COLUMN `status` enum('pendente','pronta_retirada','entregue','cancelada') NOT NULL DEFAULT 'pendente';--> statement-breakpoint
ALTER TABLE `notificacoes` MODIFY COLUMN `tipo` enum('encomenda_pendente','encomenda_pronta_retirada','encomenda_entregue','ocorrencia_registrada') NOT NULL;--> statement-breakpoint
ALTER TABLE `notificacoes` ADD `lida_em` timestamp;--> statement-breakpoint
CREATE INDEX `idx_notificacoes_morador_id` ON `notificacoes` (`morador_id`);--> statement-breakpoint
CREATE INDEX `idx_notificacoes_encomenda_id` ON `notificacoes` (`encomenda_id`);--> statement-breakpoint
CREATE INDEX `idx_notificacoes_lida` ON `notificacoes` (`lida`);