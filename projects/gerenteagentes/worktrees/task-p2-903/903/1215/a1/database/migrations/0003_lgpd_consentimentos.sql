CREATE TABLE IF NOT EXISTS `consentimentos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`data` timestamp NOT NULL DEFAULT (now()),
	`versao_politica` varchar(50) NOT NULL,
	`ip` varchar(45),
	CONSTRAINT `consentimentos_id` PRIMARY KEY(`id`),
	CONSTRAINT `consentimentos_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE cascade ON UPDATE no action,
	KEY `idx_consentimentos_usuario` (`usuario_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `logs_acesso_dados_sensiveis` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`usuario_id` bigint unsigned NOT NULL,
	`tipo_dado` varchar(50) NOT NULL,
	`acao` varchar(50) NOT NULL,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`ip` varchar(45),
	CONSTRAINT `logs_acesso_dados_sensiveis_id` PRIMARY KEY(`id`),
	CONSTRAINT `logs_acesso_dados_sensiveis_usuario_id_usuarios_id_fk` FOREIGN KEY (`usuario_id`) REFERENCES `usuarios`(`id`) ON DELETE cascade ON UPDATE no action,
	KEY `idx_logs_acesso_dados_sensiveis_usuario` (`usuario_id`)
);
--> statement-breakpoint
CREATE PROCEDURE `bg_add_lgpd_cpf_column`()
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = DATABASE() AND table_name = 'usuarios' AND column_name = 'cpf_criptografado'
	) THEN
		ALTER TABLE `usuarios` ADD `cpf_criptografado` varchar(255);
	END IF;
END;
--> statement-breakpoint
CALL `bg_add_lgpd_cpf_column`();
--> statement-breakpoint
DROP PROCEDURE `bg_add_lgpd_cpf_column`;
