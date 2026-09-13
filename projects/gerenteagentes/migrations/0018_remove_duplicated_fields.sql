-- Migration: remover campos duplicados de projetos_captados
-- repo_path e branch_trabalho já existem em projeto_motor_config
-- Esta migration:
-- 1. Copia dados de projetos_captados para projeto_motor_config (se não existir)
-- 2. Remove as colunas duplicadas de projetos_captados

-- Passo 1: Para projetos que têm repo_path/branch_trabalho mas não têm
-- config, criar config. O SQL é preparado dinamicamente porque os campos
-- legados podem já ter sido removidos em um banco parcialmente migrado.
SET @legacy_project_columns = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'projetos_captados'
      AND COLUMN_NAME IN ('repo_path', 'branch_trabalho')
);
SET @copy_project_config = IF(
    @legacy_project_columns = 2,
    'INSERT INTO projeto_motor_config (projeto_id, repo_path, branch_trabalho, build_command, unit_test_command) SELECT pc.id, COALESCE(pc.repo_path, ''/data/workspace/projects/codigofonte/biblioteca-global''), COALESCE(pc.branch_trabalho, ''base-desenvolvimento''), ''npm run build'', ''npm run test'' FROM projetos_captados pc LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id WHERE pmc.id IS NULL AND (pc.repo_path IS NOT NULL OR pc.branch_trabalho IS NOT NULL)',
    'SELECT 1'
);
PREPARE copy_project_config_stmt FROM @copy_project_config;
EXECUTE copy_project_config_stmt;
DEALLOCATE PREPARE copy_project_config_stmt;

-- Passo 2: atualizar configurações existentes somente quando os campos
-- legados ainda estiverem presentes.
SET @update_project_config = IF(
    @legacy_project_columns = 2,
    'UPDATE projeto_motor_config pmc JOIN projetos_captados pc ON pc.id = pmc.projeto_id SET pmc.repo_path = CASE WHEN pc.repo_path IS NOT NULL AND pc.repo_path != '''' THEN pc.repo_path ELSE pmc.repo_path END, pmc.branch_trabalho = CASE WHEN pc.branch_trabalho IS NOT NULL AND pc.branch_trabalho != '''' THEN pc.branch_trabalho ELSE pmc.branch_trabalho END WHERE pmc.repo_path = ''/data/workspace/projects/codigofonte/biblioteca-global'' OR pmc.branch_trabalho = ''base-desenvolvimento''',
    'SELECT 1'
);
PREPARE update_project_config_stmt FROM @update_project_config;
EXECUTE update_project_config_stmt;
DEALLOCATE PREPARE update_project_config_stmt;

-- Passo 3: Remover colunas duplicadas de projetos_captados.
-- O schema atual de alguns ambientes já não possui essas colunas porque a
-- migration original foi aplicada antes de o journal ser consolidado. A
-- remoção condicional permite que o journal histórico seja reaplicado sem
-- transformar uma diferença legítima de estado em falha de deploy.
SET @repo_path_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'projetos_captados'
      AND COLUMN_NAME = 'repo_path'
);
SET @drop_repo_path = IF(
    @repo_path_exists > 0,
    'ALTER TABLE projetos_captados DROP COLUMN repo_path',
    'SELECT 1'
);
PREPARE drop_repo_path_stmt FROM @drop_repo_path;
EXECUTE drop_repo_path_stmt;
DEALLOCATE PREPARE drop_repo_path_stmt;

SET @branch_trabalho_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'projetos_captados'
      AND COLUMN_NAME = 'branch_trabalho'
);
SET @drop_branch_trabalho = IF(
    @branch_trabalho_exists > 0,
    'ALTER TABLE projetos_captados DROP COLUMN branch_trabalho',
    'SELECT 1'
);
PREPARE drop_branch_trabalho_stmt FROM @drop_branch_trabalho;
EXECUTE drop_branch_trabalho_stmt;
DEALLOCATE PREPARE drop_branch_trabalho_stmt;
