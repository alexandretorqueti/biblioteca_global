CREATE TABLE IF NOT EXISTS `tarefa_eventos` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tarefa_id` bigint unsigned NULL,
  `tarefa_external_id` varchar(64) NULL,
  `evento` varchar(40) NOT NULL,
  `ator` varchar(255) NOT NULL,
  `origem` varchar(40) NOT NULL,
  `payload` json NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `tarefa_eventos_tarefa_idx` (`tarefa_id`),
  KEY `tarefa_eventos_external_idx` (`tarefa_external_id`),
  KEY `tarefa_eventos_created_idx` (`created_at`)
);
