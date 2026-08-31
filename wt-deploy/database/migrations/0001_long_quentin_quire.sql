CREATE TABLE `email_verifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`used_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `usuarios` MODIFY COLUMN `password_hash` varchar(255);--> statement-breakpoint
CREATE INDEX `idx_email_verifications_email` ON `email_verifications` (`email`);