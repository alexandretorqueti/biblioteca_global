-- Migration: adicionar configuração de conexão MySQL por projeto (PoC §6.1).
-- Colunas opcionais: quando todas NULL, a ProjectDbFactory usa o env padrão.
-- A senha é armazenada criptografada (AES-256-GCM).
-- Idempotente: verifica existência antes de ADD COLUMN (MySQL 8 não suporta IF NOT EXISTS para ADD COLUMN).

-- db_host: host do MySQL customizado
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projetos' AND COLUMN_NAME = 'db_host');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `projetos` ADD COLUMN `db_host` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- db_port: porta do MySQL customizado
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projetos' AND COLUMN_NAME = 'db_port');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `projetos` ADD COLUMN `db_port` INT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- db_database: nome do database no MySQL customizado
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projetos' AND COLUMN_NAME = 'db_database');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `projetos` ADD COLUMN `db_database` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- db_user: usuário do MySQL customizado
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projetos' AND COLUMN_NAME = 'db_user');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `projetos` ADD COLUMN `db_user` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- db_password_criptografado: senha criptografada (AES-256-GCM) — NUNCA em texto puro
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projetos' AND COLUMN_NAME = 'db_password_criptografado');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `projetos` ADD COLUMN `db_password_criptografado` VARCHAR(512) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
