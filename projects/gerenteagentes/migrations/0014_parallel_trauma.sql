CREATE TABLE IF NOT EXISTS `email_verifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`chat_id` bigint unsigned NOT NULL,
	`email` varchar(200) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL DEFAULT (now()),
	`attempts` int NOT NULL DEFAULT 0,
	`used` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `visitas_site` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`visitor_key` varchar(255),
	`page_url` varchar(4000),
	`referrer` varchar(4000),
	`user_agent` varchar(2000),
	`ip_hash` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visitas_site_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_verifications` ADD CONSTRAINT `email_verifications_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE cascade ON UPDATE no action;
