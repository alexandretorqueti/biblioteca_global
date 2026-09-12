-- Materializa a configuração global somente no momento da criação do projeto.
-- Configurações editadas posteriormente no projeto permanecem independentes.
--
-- Nota de collation: `projetos_captados.slug` e `project_model_selection.project_slug`
-- podem divergir de collation (ex.: utf8mb4_0900_ai_ci vs utf8mb4_unicode_ci),
-- o que faz o comparativo do trigger falhar com "Illegal mix of collations".
-- A comparação abaixo força uma collation explícita (portável em MySQL 8.x) para
-- não depender do default do servidor.
CREATE TABLE IF NOT EXISTS `project_model_selection` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `project_slug` varchar(100) NOT NULL,
  `tipo` enum('DEV', 'ANALYST', 'MONITOR') NOT NULL,
  `ordem` int NOT NULL,
  `provider` varchar(100) NOT NULL,
  `model` varchar(200) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  PRIMARY KEY (`id`),
  UNIQUE KEY `project_model_selection_project_tipo_ordem_unique` (`project_slug`, `tipo`, `ordem`),
  KEY `project_model_selection_project_tipo_idx` (`project_slug`, `tipo`)
);--> statement-breakpoint

DROP TRIGGER IF EXISTS `projetos_captados_inherit_global_model_selection`;--> statement-breakpoint

CREATE TRIGGER `projetos_captados_inherit_global_model_selection`
AFTER INSERT ON `projetos_captados`
FOR EACH ROW
INSERT INTO `project_model_selection` (`project_slug`, `tipo`, `ordem`, `provider`, `model`, `enabled`)
SELECT NEW.`slug`, `tipo`, `ordem`, `provider`, `model`, `enabled`
FROM `global_model_selection`
WHERE NOT EXISTS (
  SELECT 1
  FROM `project_model_selection` AS existing
  WHERE existing.`project_slug` = NEW.`slug` COLLATE utf8mb4_unicode_ci
);
