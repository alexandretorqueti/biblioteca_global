-- Cooldown global de modelos (2026-09-13, Alexandre).
--
-- Quando o provedor de um modelo está indisponível (sem token/autenticação,
-- cota esgotada, modelo removido) ou a sessão não entrega, o Motor deixa de
-- chamar esse modelo por um período. Sem isso, cada nova subtarefa reinicia a
-- cadeia do zero e bate de novo no modelo quebrado como primeira tentativa.
--
-- Escopo GLOBAL por (provider, model): token e cota pertencem à conta, não ao
-- projeto. Reincidência aumenta o tempo (config `motor.model_cooldown_growth_factor`),
-- com teto em `motor.model_cooldown_max_ms`.
CREATE TABLE IF NOT EXISTS `modelo_cooldown` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `provider` varchar(64) NOT NULL,
  `model` varchar(191) NOT NULL,
  `motivo_classe` varchar(32) NOT NULL,
  `motivo` varchar(500) NULL,
  `strikes` int NOT NULL DEFAULT 1,
  `bloqueado_ate` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `modelo_cooldown_pk` PRIMARY KEY (`id`),
  CONSTRAINT `modelo_cooldown_modelo_uk` UNIQUE (`provider`,`model`),
  KEY `modelo_cooldown_ate_idx` (`bloqueado_ate`)
);
