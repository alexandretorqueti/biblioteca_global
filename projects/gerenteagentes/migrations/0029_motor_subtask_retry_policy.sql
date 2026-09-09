-- Retry policy: campos de controle de reenfileiramento para subtarefas que
-- falharam sem resposta verificável do runtime (remote_no_reply / runtime_unavailable).
-- Compatível com subtarefas existentes (todos os campos NULL por padrão).

ALTER TABLE `subtarefas` ADD `next_retry_at` timestamp NULL;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `failure_classification` varchar(30) NULL;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `failure_fingerprint` varchar(600) NULL;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `failure_diagnostic` text NULL;
