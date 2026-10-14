-- Limites de paralelismo por provider (aba PROVIDERS da tela CONFIGURAÇÕES).
-- `provider` usa o mesmo domínio de valor da coluna `provider` de
-- global_model_selection/project_model_selection e do catálogo do Console
-- (fonte: GET /api/gerenteagentes/modelos-console).
-- LIMITES NULL = sem restrição por provider (vale apenas o limite geral do Motor).
-- A semântica de aplicação (menor valor entre geral/provider, com limite de
-- provider absoluto compartilhado entre análise/desenvolvimento) é da
-- responsabilidade do Motor; esta migration apenas persiste a configuração.
-- IF NOT EXISTS: DDL MySQL não é transacional; se o container for interrompido
-- entre o CREATE e o registro no __drizzle_migrations, a tabela órfã não pode
-- bloquear o retry da migration (padrão da 0085, incidente task-p2-984).
CREATE TABLE IF NOT EXISTS `motor_provider_limits` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `provider` varchar(100) NOT NULL,
  `limite_execucao_total` int unsigned NULL,
  `limite_analises` int unsigned NULL,
  `limite_desenvolvimento` int unsigned NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `motor_provider_limits_provider_uq` (`provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
