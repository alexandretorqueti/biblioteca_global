ALTER TABLE `bloqueios` ADD `subtarefa_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `chat_mensagens` ADD `attachments` json;--> statement-breakpoint
ALTER TABLE `chat_mensagens` ADD `typing` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_mensagens` ADD `seq` int;--> statement-breakpoint
ALTER TABLE `chats` ADD `chat_key` varchar(200);--> statement-breakpoint
ALTER TABLE `chats` ADD `session_key` varchar(200);--> statement-breakpoint
ALTER TABLE `chats` ADD `visitor_name` varchar(150);--> statement-breakpoint
ALTER TABLE `chats` ADD `pending_email` varchar(200);--> statement-breakpoint
ALTER TABLE `chats` ADD `merged_into` bigint unsigned;--> statement-breakpoint
ALTER TABLE `chats` ADD `handoffs` json;--> statement-breakpoint
ALTER TABLE `chats` ADD `session_keys` json;--> statement-breakpoint
ALTER TABLE `chats` ADD `email` varchar(200);--> statement-breakpoint
ALTER TABLE `chats` ADD `name` varchar(150);--> statement-breakpoint
ALTER TABLE `geracoes_projeto` ADD `tasks` json;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `acceptance_criteria` json;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `deliver_count` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD `depends_on_subtask_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `bloqueios` ADD CONSTRAINT `bloqueios_subtarefa_id_subtarefas_id_fk` FOREIGN KEY (`subtarefa_id`) REFERENCES `subtarefas`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subtarefas` ADD CONSTRAINT `subtarefas_depends_on_subtask_id_subtarefas_id_fk` FOREIGN KEY (`depends_on_subtask_id`) REFERENCES `subtarefas`(`id`) ON DELETE set null ON UPDATE no action;