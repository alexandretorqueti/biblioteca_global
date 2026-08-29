CREATE TABLE IF NOT EXISTS `projeto_model_chain` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `projeto_id` bigint unsigned NOT NULL,
  `fase` varchar(30) NOT NULL,
  `modelo` varchar(150) NOT NULL,
  `posicao` int NOT NULL,
  `ativo` boolean NOT NULL DEFAULT true,
  `is_local` boolean NOT NULL DEFAULT false,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `projeto_model_chain_id` PRIMARY KEY(`id`),
  CONSTRAINT `projeto_model_chain_projeto_fase_posicao_unique` UNIQUE(`projeto_id`,`fase`,`posicao`),
  CONSTRAINT `projeto_model_chain_projeto_id_projetos_captados_id_fk`
    FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados`(`id`) ON DELETE cascade
);
