ALTER TABLE `subtarefas`
  ADD COLUMN `revision` int NOT NULL DEFAULT 0,
  ADD COLUMN `replaces_subtask_id` bigint unsigned NULL,
  ADD COLUMN `superseded_by_subtask_id` bigint unsigned NULL,
  ADD COLUMN `rebrief_count` int NOT NULL DEFAULT 0,
  ADD COLUMN `premise_fingerprint` varchar(500) NULL,
  ADD COLUMN `premise_evidence` json NULL;

ALTER TABLE `prompts_agentes`
  MODIFY COLUMN `chave` varchar(160) NOT NULL,
  ADD COLUMN `titulo` varchar(200) NULL,
  ADD COLUMN `descricao` text NULL,
  ADD COLUMN `status` enum('draft','active','inactive') NOT NULL DEFAULT 'draft',
  ADD COLUMN `versao_ativa_id` bigint unsigned NULL;
UPDATE `prompts_agentes` SET `titulo` = `chave` WHERE `titulo` IS NULL;
ALTER TABLE `prompts_agentes` MODIFY COLUMN `titulo` varchar(200) NOT NULL;

CREATE TABLE `prompts_mascaras` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT, `nome` varchar(100) NOT NULL,
  `descricao` text NOT NULL, `tipo_valor` varchar(30) NOT NULL DEFAULT 'texto',
  `exemplo` text NULL, `origem` varchar(300) NOT NULL,
  `obrigatoria` tinyint(1) NOT NULL DEFAULT 0, `sensivel` tinyint(1) NOT NULL DEFAULT 0,
  `ativa` tinyint(1) NOT NULL DEFAULT 1, `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `prompts_mascaras_nome_unique` (`nome`)
);

CREATE TABLE `prompts_versoes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT, `prompt_id` bigint unsigned NOT NULL,
  `versao` int NOT NULL, `texto` text NOT NULL, `motivo` text NULL,
  `autor` varchar(200) NULL, `validacao` json NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `prompts_versoes_prompt_versao_unique` (`prompt_id`,`versao`),
  CONSTRAINT `prompts_versoes_prompt_fk` FOREIGN KEY (`prompt_id`) REFERENCES `prompts_agentes` (`id`) ON DELETE CASCADE
);
ALTER TABLE `prompts_agentes` ADD CONSTRAINT `prompts_agentes_versao_ativa_fk` FOREIGN KEY (`versao_ativa_id`) REFERENCES `prompts_versoes` (`id`) ON DELETE SET NULL;

CREATE TABLE `prompts_execucoes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT, `prompt_id` bigint unsigned NULL,
  `versao_id` bigint unsigned NULL, `chave` varchar(160) NOT NULL,
  `tarefa_id` varchar(64) NULL, `subtarefa_id` bigint unsigned NULL,
  `fallback_usado` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), KEY `prompts_execucoes_chave_idx` (`chave`),
  CONSTRAINT `prompts_execucoes_prompt_fk` FOREIGN KEY (`prompt_id`) REFERENCES `prompts_agentes` (`id`) ON DELETE SET NULL,
  CONSTRAINT `prompts_execucoes_versao_fk` FOREIGN KEY (`versao_id`) REFERENCES `prompts_versoes` (`id`) ON DELETE SET NULL
);
