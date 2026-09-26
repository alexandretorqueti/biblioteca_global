CREATE TABLE IF NOT EXISTS `projeto_motor_config` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `projeto_id` bigint unsigned NOT NULL,
  `repo_path` varchar(500) NOT NULL,
  `branch_trabalho` varchar(255) NOT NULL,
  `build_command` varchar(500) NOT NULL,
  `unit_test_command` varchar(500) NOT NULL,
  `unit_test_exclude` json,
  `default_max_rework` int NOT NULL DEFAULT 3,
  `default_hard_timeout_ms` bigint NOT NULL DEFAULT 3600000,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `projeto_motor_config_id` PRIMARY KEY(`id`),
  CONSTRAINT `projeto_motor_config_projeto_id_unique` UNIQUE(`projeto_id`),
  CONSTRAINT `projeto_motor_config_projeto_id_projetos_captados_id_fk`
    FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade
);
