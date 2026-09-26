CREATE TABLE IF NOT EXISTS `global_model_selection` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tipo` enum('DEV', 'ANALYST', 'MONITOR') NOT NULL,
  `ordem` int NOT NULL,
  `provider` varchar(100) NOT NULL,
  `model` varchar(200) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  PRIMARY KEY (`id`),
  UNIQUE KEY `global_model_selection_tipo_ordem_unique` (`tipo`, `ordem`),
  KEY `global_model_selection_tipo_enabled_idx` (`tipo`, `enabled`)
);
