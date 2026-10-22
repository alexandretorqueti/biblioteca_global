CREATE TABLE `logs_login` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned,
	`email` varchar(255) NOT NULL,
	`metodo` enum('senha','codigo_email') NOT NULL,
	`codigo` varchar(10),
	`ip` varchar(45),
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `logs_login_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `logs_login` ADD CONSTRAINT `logs_login_usuario_id_usuarios_id_fk`
	FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`)
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_logs_login_timestamp` ON `logs_login` (`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_logs_login_usuario_id` ON `logs_login` (`usuario_id`);
