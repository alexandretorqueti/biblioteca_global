CREATE TABLE `transbordo_config` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tenant_slug` varchar(100) NOT NULL,
  `ativo` boolean NOT NULL DEFAULT false,
  `destino_tipo` enum('email','telegram','whatsapp') NOT NULL,
  `destino_valor` varchar(320) NOT NULL,
  `atendente_nome` varchar(150) NOT NULL,
  `horario` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `transbordo_config_id` PRIMARY KEY(`id`),
  CONSTRAINT `transbordo_config_tenant_slug_unique` UNIQUE(`tenant_slug`)
);
--> statement-breakpoint
CREATE TABLE `transbordos` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tenant_slug` varchar(100) NOT NULL,
  `sessao_id` bigint unsigned NOT NULL,
  `estado` enum('pending','active','released','expired','cancelled') NOT NULL DEFAULT 'pending',
  `notificacao_estado` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
  `notificacao_tentada_em` timestamp NULL,
  `notificacao_enviada_em` timestamp NULL,
  `notificacao_erro` varchar(1000),
  `token_liberacao_hash` varchar(128) NOT NULL,
  `token_liberacao_expira_em` timestamp NOT NULL,
  `token_liberacao_usado_em` timestamp NULL,
  `liberado_em` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `transbordos_id` PRIMARY KEY(`id`),
  CONSTRAINT `transbordos_token_liberacao_hash_unique` UNIQUE(`token_liberacao_hash`),
  CONSTRAINT `transbordos_sessao_id_helpdesk_sessoes_id_fk` FOREIGN KEY (`sessao_id`) REFERENCES `helpdesk_sessoes`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transbordos_tenant_slug` ON `transbordos` (`tenant_slug`);
--> statement-breakpoint
CREATE INDEX `idx_transbordos_sessao_id` ON `transbordos` (`sessao_id`);
--> statement-breakpoint
CREATE INDEX `idx_transbordos_estado` ON `transbordos` (`estado`);
