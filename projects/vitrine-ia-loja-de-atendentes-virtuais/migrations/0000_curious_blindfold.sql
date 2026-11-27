CREATE TABLE `agentes_provisionados` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`pedido_id` bigint unsigned NOT NULL,
	`openclaw_agente_id` varchar(120),
	`nome` varchar(160),
	`status` enum('pendente','provisionando','ativo','falha') NOT NULL DEFAULT 'pendente',
	`personalidade` json,
	`link_acesso` varchar(300),
	`script_embed` text,
	`tentativas` int NOT NULL DEFAULT 0,
	`ultimo_erro` text,
	CONSTRAINT `agentes_provisionados_id` PRIMARY KEY(`id`),
	CONSTRAINT `agentes_provisionados_pedido_unico` UNIQUE(`pedido_id`)
);
--> statement-breakpoint
CREATE TABLE `configuracoes_whatsapp` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`agente_id` bigint unsigned NOT NULL,
	`status_pareamento` enum('pendente','qr_gerado','pareado','expirado') NOT NULL DEFAULT 'pendente',
	`alcance` enum('todos','whitelist') NOT NULL DEFAULT 'todos',
	`numeros_permitidos` json,
	`ultimo_qr_gerado_em` datetime,
	CONSTRAINT `configuracoes_whatsapp_id` PRIMARY KEY(`id`),
	CONSTRAINT `configuracoes_whatsapp_agente_unico` UNIQUE(`agente_id`)
);
--> statement-breakpoint
CREATE TABLE `documentos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`pedido_id` bigint unsigned NOT NULL,
	`nome_original` varchar(255),
	`mime_type` varchar(120),
	`tamanho_bytes` bigint,
	`caminho_armazenamento` varchar(500),
	`tipo_conteudo` enum('pdf','docx','txt','texto_livre') NOT NULL,
	`texto_extraido` longtext,
	CONSTRAINT `documentos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `integracoes_externas` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`pedido_id` bigint unsigned NOT NULL,
	`nome` varchar(120) NOT NULL,
	`url_base` varchar(300) NOT NULL,
	`tipo_autenticacao` enum('api_key','oauth2','nenhuma') NOT NULL,
	`credenciais_cifradas` text,
	`headers` json,
	`limite_requisicoes_minuto` int,
	`somente_leitura` boolean NOT NULL DEFAULT true,
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `integracoes_externas_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `itens_faq` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`pergunta` text NOT NULL,
	`resposta` text NOT NULL,
	`ordem` int,
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `itens_faq_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `metricas_destaque` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`valor` varchar(30) NOT NULL,
	`rotulo` varchar(120),
	`ordem` int,
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `metricas_destaque_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pedidos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome_negocio` varchar(160) NOT NULL,
	`nome_contato` varchar(160) NOT NULL,
	`email` varchar(160) NOT NULL,
	`telefone` varchar(20) NOT NULL,
	`plano_id` bigint unsigned NOT NULL,
	`ciclo` enum('mensal','anual') NOT NULL,
	`informacoes_negocio` text,
	`status` enum('criado','aguardando_pagamento','pago','provisionando','entregue','falha') NOT NULL DEFAULT 'criado',
	`pagamento_id` varchar(120),
	`link_agente` varchar(300),
	`script_embed` text,
	`consentimento_lgpd` boolean NOT NULL,
	`criado_em` timestamp NOT NULL DEFAULT (now()),
	`em_atualizacao` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `pedidos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `planos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`nome` varchar(120) NOT NULL,
	`tagline` varchar(200),
	`preco_mensal` decimal(10,2) NOT NULL,
	`preco_setup` decimal(10,2),
	`beneficios` json,
	`texto_botao` varchar(60),
	`mais_popular` boolean NOT NULL DEFAULT false,
	`ordem` int,
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `planos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `segmentos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`titulo` varchar(120) NOT NULL,
	`descricao` text,
	`icone` varchar(60),
	`ordem` int,
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `segmentos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `textos_vitrine` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`chave` varchar(80) NOT NULL,
	`conteudo` text NOT NULL,
	`secao` enum('hero','dores','beneficios','como_funciona','cta','contato'),
	`ativo` boolean NOT NULL DEFAULT true,
	CONSTRAINT `textos_vitrine_id` PRIMARY KEY(`id`),
	CONSTRAINT `textos_vitrine_chave_unica` UNIQUE(`chave`)
);
--> statement-breakpoint
ALTER TABLE `agentes_provisionados` ADD CONSTRAINT `agentes_provisionados_pedido_id_pedidos_id_fk` FOREIGN KEY (`pedido_id`) REFERENCES `pedidos`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `configuracoes_whatsapp` ADD CONSTRAINT `configuracoes_whatsapp_agente_id_agentes_provisionados_id_fk` FOREIGN KEY (`agente_id`) REFERENCES `agentes_provisionados`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `documentos` ADD CONSTRAINT `documentos_pedido_id_pedidos_id_fk` FOREIGN KEY (`pedido_id`) REFERENCES `pedidos`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `integracoes_externas` ADD CONSTRAINT `integracoes_externas_pedido_id_pedidos_id_fk` FOREIGN KEY (`pedido_id`) REFERENCES `pedidos`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `pedidos` ADD CONSTRAINT `pedidos_plano_id_planos_id_fk` FOREIGN KEY (`plano_id`) REFERENCES `planos`(`id`) ON DELETE no action ON UPDATE no action;