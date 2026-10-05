-- Migration 0004: Espelhar schema legado bdportalemp
-- Renomeia tabelas e ajusta colunas para coincidir com o schema legado migrado

-- ============================================================================
-- 1. CIRCULARES → CIRCULAR
-- ============================================================================
RENAME TABLE `circulares` TO `circular`;
--> statement-breakpoint
ALTER TABLE `circular` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `circular` DROP COLUMN `updated_at`;
--> statement-breakpoint
ALTER TABLE `circular` ADD COLUMN `autor` varchar(100);
--> statement-breakpoint
ALTER TABLE `circular` ADD COLUMN `ativo` tinyint(1) DEFAULT 1;

-- ============================================================================
-- 2. CONTATOS_SITE → API_CONTATOSITE_CONTATOS
-- ============================================================================
RENAME TABLE `contatos_site` TO `api_contatosite_contatos`;
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` ADD COLUMN `site_id` bigint unsigned NOT NULL FIRST;
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` ADD COLUMN `ip` varchar(45);
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` ADD COLUMN `user_agent` varchar(500);
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` ADD COLUMN `origem` varchar(200);
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` MODIFY COLUMN `nome` varchar(100) NOT NULL;
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` MODIFY COLUMN `email` varchar(150) NOT NULL;
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` MODIFY COLUMN `telefone` varchar(20);
--> statement-breakpoint
ALTER TABLE `api_contatosite_contatos` MODIFY COLUMN `assunto` varchar(150) NOT NULL DEFAULT '';

-- ============================================================================
-- 3. USUARIOS — adicionar senha, primeiro_acesso; ajustar tipos
-- ============================================================================
ALTER TABLE `usuarios` ADD COLUMN `senha` varchar(255) AFTER `email`;
--> statement-breakpoint
ALTER TABLE `usuarios` ADD COLUMN `primeiro_acesso` tinyint(1) DEFAULT 1 AFTER `ativo`;
--> statement-breakpoint
ALTER TABLE `usuarios` DROP INDEX `usuarios_email_unique`;
--> statement-breakpoint
ALTER TABLE `usuarios` MODIFY COLUMN `nome` varchar(100);
--> statement-breakpoint
ALTER TABLE `usuarios` MODIFY COLUMN `email` varchar(150) NOT NULL;
--> statement-breakpoint
ALTER TABLE `usuarios` MODIFY COLUMN `papel` varchar(50);
--> statement-breakpoint
ALTER TABLE `usuarios` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `usuarios` DROP COLUMN `updated_at`;

-- ============================================================================
-- 4. CLIENTES — ajustar para schema legado
-- ============================================================================
ALTER TABLE `clientes` DROP FOREIGN KEY `clientes_administrador_id_usuarios_id_fk`;
--> statement-breakpoint
ALTER TABLE `clientes` DROP COLUMN `administrador_id`;
--> statement-breakpoint
ALTER TABLE `clientes` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `clientes` DROP COLUMN `updated_at`;
--> statement-breakpoint
ALTER TABLE `clientes` ADD COLUMN `usuario` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` ADD COLUMN `data` timestamp DEFAULT (now());
--> statement-breakpoint
ALTER TABLE `clientes` ADD COLUMN `data_edicao` timestamp DEFAULT (now());
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `nome_fantasia` varchar(100);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `razao_social` varchar(100);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `cnpj` varchar(20);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `inscricao_municipal` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `inscricao_estadual` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `logradouro` varchar(100);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `numero` varchar(10);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `complemento` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `bairro` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `cidade` varchar(50);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `uf` varchar(2);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `cep` varchar(10);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `telefone` varchar(20);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `ramal` varchar(10);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `instagram` varchar(200);
--> statement-breakpoint
ALTER TABLE `clientes` MODIFY COLUMN `email` varchar(100);

-- ============================================================================
-- 5. RESPONSÁVEIS — adicionar colunas de endereço e contato
-- ============================================================================
ALTER TABLE `responsaveis` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `responsaveis` DROP COLUMN `updated_at`;
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `cpf` varchar(14);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `logradouro` varchar(100);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `numero` varchar(10);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `complemento` varchar(50);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `bairro` varchar(50);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `cidade` varchar(50);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `uf` varchar(2);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `cep` varchar(10);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `ramal` varchar(10);
--> statement-breakpoint
ALTER TABLE `responsaveis` ADD COLUMN `data` timestamp DEFAULT (now());
--> statement-breakpoint
ALTER TABLE `responsaveis` MODIFY COLUMN `cliente_id` bigint unsigned;
--> statement-breakpoint
ALTER TABLE `responsaveis` MODIFY COLUMN `nome` varchar(100);
--> statement-breakpoint
ALTER TABLE `responsaveis` MODIFY COLUMN `cargo` varchar(100);
--> statement-breakpoint
ALTER TABLE `responsaveis` MODIFY COLUMN `telefone` varchar(20);
--> statement-breakpoint
ALTER TABLE `responsaveis` MODIFY COLUMN `email` varchar(100);

-- ============================================================================
-- 6. CONTRATOS — renomear numero→numerocontrato, adicionar linkcontrato
-- ============================================================================
ALTER TABLE `contratos` DROP FOREIGN KEY `contratos_cliente_id_clientes_id_fk`;
--> statement-breakpoint
ALTER TABLE `contratos` CHANGE COLUMN `numero` `numerocontrato` varchar(50);
--> statement-breakpoint
ALTER TABLE `contratos` ADD COLUMN `linkcontrato` varchar(255) AFTER `numerocontrato`;
--> statement-breakpoint
ALTER TABLE `contratos` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `contratos` DROP COLUMN `updated_at`;
--> statement-breakpoint
ALTER TABLE `contratos` ADD COLUMN `data` timestamp DEFAULT (now());
--> statement-breakpoint
ALTER TABLE `contratos` MODIFY COLUMN `cliente_id` bigint unsigned;
--> statement-breakpoint
ALTER TABLE `contratos` MODIFY COLUMN `descricao` text;
--> statement-breakpoint
ALTER TABLE `contratos` MODIFY COLUMN `valor` varchar(30);
--> statement-breakpoint
ALTER TABLE `contratos` MODIFY COLUMN `inicio` varchar(10);
--> statement-breakpoint
ALTER TABLE `contratos` MODIFY COLUMN `fim` varchar(10);
--> statement-breakpoint
ALTER TABLE `contratos` ADD CONSTRAINT `contratos_cliente_id_clientes_id_fk` FOREIGN KEY (`cliente_id`) REFERENCES `clientes`(`id`) ON DELETE cascade;

-- ============================================================================
-- 7. DEPARTAMENTOS — ajustar tamanho do nome
-- ============================================================================
ALTER TABLE `departamentos` MODIFY COLUMN `nome` varchar(100) NOT NULL;

-- ============================================================================
-- 8. CONFIG_EMPRESA — ajustar tamanhos e remover timestamps
-- ============================================================================
ALTER TABLE `config_empresa` DROP COLUMN `created_at`;
--> statement-breakpoint
ALTER TABLE `config_empresa` DROP COLUMN `updated_at`;
--> statement-breakpoint
ALTER TABLE `config_empresa` MODIFY COLUMN `nome` varchar(100);
--> statement-breakpoint
ALTER TABLE `config_empresa` MODIFY COLUMN `logo_url` varchar(255);
--> statement-breakpoint
ALTER TABLE `config_empresa` MODIFY COLUMN `endereco` varchar(255);
--> statement-breakpoint
ALTER TABLE `config_empresa` MODIFY COLUMN `cnpj` varchar(18);
--> statement-breakpoint
ALTER TABLE `config_empresa` MODIFY COLUMN `telefone` varchar(20);
