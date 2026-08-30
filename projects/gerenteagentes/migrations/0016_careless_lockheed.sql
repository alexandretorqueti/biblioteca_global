ALTER TABLE `definicoes` MODIFY COLUMN `projeto_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `chats` ADD `nome_projeto` varchar(200);--> statement-breakpoint
ALTER TABLE `definicoes` ADD `chat_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `definicoes` ADD CONSTRAINT `definicoes_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE cascade ON UPDATE no action;