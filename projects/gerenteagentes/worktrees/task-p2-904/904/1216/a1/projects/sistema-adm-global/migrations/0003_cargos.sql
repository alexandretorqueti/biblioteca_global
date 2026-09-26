-- Criação da tabela cargos
CREATE TABLE `cargos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(100) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cargos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
-- Migra dados existentes: cada valor distinto de cargo vira um registro
INSERT INTO `cargos` (`nome`) SELECT DISTINCT `cargo` FROM `colaboradores`;
--> statement-breakpoint
-- Adiciona coluna cargo_id
ALTER TABLE `colaboradores` ADD COLUMN `cargo_id` bigint unsigned;
--> statement-breakpoint
-- Vincula colaboradores aos cargos recém-criados
UPDATE `colaboradores` SET `cargo_id` = (SELECT `id` FROM `cargos` WHERE `cargos`.`nome` = `colaboradores`.`cargo`);
--> statement-breakpoint
-- Torna cargo_id NOT NULL
ALTER TABLE `colaboradores` MODIFY `cargo_id` bigint unsigned NOT NULL;
--> statement-breakpoint
-- Adiciona FK com ON DELETE restrict
ALTER TABLE `colaboradores` ADD CONSTRAINT `colaboradores_cargo_id_cargos_id_fk` FOREIGN KEY (`cargo_id`) REFERENCES `cargos`(`id`) ON DELETE restrict;
--> statement-breakpoint
-- Remove coluna antiga cargo
ALTER TABLE `colaboradores` DROP COLUMN `cargo`;
