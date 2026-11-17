CREATE TABLE `knowledge_documents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`nome` varchar(255) NOT NULL,
	`mime_type` varchar(150) NOT NULL,
	`tamanho_bytes` bigint unsigned NOT NULL,
	`caminho_storage` varchar(500) NOT NULL,
	`status` enum('pending','indexing','ready','failed') NOT NULL DEFAULT 'pending',
	`erro` varchar(1000),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_documents_caminho_storage_unique` UNIQUE(`caminho_storage`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD CONSTRAINT `knowledge_documents_projeto_id_projetos_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_knowledge_documents_projeto` ON `knowledge_documents` (`projeto_id`);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_documents_status` ON `knowledge_documents` (`status`);
--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`projeto_id` bigint unsigned NOT NULL,
	`documento_id` bigint unsigned NOT NULL,
	`ordem` int NOT NULL,
	`texto` varchar(12000) NOT NULL,
	`embedding` json NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `knowledge_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD CONSTRAINT `knowledge_chunks_projeto_id_projetos_id_fk` FOREIGN KEY (`projeto_id`) REFERENCES `projetos`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD CONSTRAINT `knowledge_chunks_documento_id_knowledge_documents_id_fk` FOREIGN KEY (`documento_id`) REFERENCES `knowledge_documents`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_projeto` ON `knowledge_chunks` (`projeto_id`);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_documento` ON `knowledge_chunks` (`documento_id`);
