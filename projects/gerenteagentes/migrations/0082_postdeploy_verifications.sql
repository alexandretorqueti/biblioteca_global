-- Migration: tabela para auditoria de verificações pós-deploy (tarefa 971).
-- Armazena o estado de cada verificação por batch_id (idempotente).
-- verdict_json contém o veredito estruturado parseado.

CREATE TABLE IF NOT EXISTS `motor_postdeploy_verifications` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` VARCHAR(255) NOT NULL,
  `status` ENUM('pending', 'consistent', 'incongruent', 'inconclusive', 'failed') NOT NULL DEFAULT 'pending',
  `verdict_json` LONGTEXT NULL,
  `retry_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_id` (`batch_id`),
  KEY `idx_status` (`status`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: flag de ativação da verificação pós-deploy (default true).
-- Independente de motor.monitor.active.
INSERT INTO `motor_configuracoes` (`chave`, `tipo`, `valor`, `valor_padrao`, `regra_validacao`, `descricao`)
VALUES (
  'motor.postdeploy_verification.active',
  'boolean',
  'true',
  'true',
  '',
  'Ativa/desativa a verificação semântica pós-deploy pelo Monitor (tarefa 971)'
)
ON DUPLICATE KEY UPDATE `descricao` = VALUES(`descricao`), `updated_at` = NOW();
