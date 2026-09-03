-- Migration: remover campos duplicados de projetos_captados
-- repo_path e branch_trabalho já existem em projeto_motor_config
-- Esta migration:
-- 1. Copia dados de projetos_captados para projeto_motor_config (se não existir)
-- 2. Remove as colunas duplicadas de projetos_captados

-- Passo 1: Para projetos que têm repo_path/branch_trabalho mas não têm config, criar config
INSERT INTO projeto_motor_config (projeto_id, repo_path, branch_trabalho, build_command, unit_test_command)
SELECT 
    pc.id,
    COALESCE(pc.repo_path, '/data/workspace/projects/codigofonte/biblioteca-global'),
    COALESCE(pc.branch_trabalho, 'base-desenvolvimento'),
    'npm run build',
    'npm run test'
FROM projetos_captados pc
LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id
WHERE pmc.id IS NULL AND (pc.repo_path IS NOT NULL OR pc.branch_trabalho IS NOT NULL);

-- Passo 2: Para projetos que já têm config mas com valores padrão, atualizar se projetos_captados tiver valores diferentes
UPDATE projeto_motor_config pmc
JOIN projetos_captados pc ON pc.id = pmc.projeto_id
SET 
    pmc.repo_path = CASE WHEN pc.repo_path IS NOT NULL AND pc.repo_path != '' THEN pc.repo_path ELSE pmc.repo_path END,
    pmc.branch_trabalho = CASE WHEN pc.branch_trabalho IS NOT NULL AND pc.branch_trabalho != '' THEN pc.branch_trabalho ELSE pmc.branch_trabalho END
WHERE pmc.repo_path = '/data/workspace/projects/codigofonte/biblioteca-global' 
   OR pmc.branch_trabalho = 'base-desenvolvimento';

-- Passo 3: Remover colunas duplicadas de projetos_captados
ALTER TABLE projetos_captados DROP COLUMN repo_path;
ALTER TABLE projetos_captados DROP COLUMN branch_trabalho;
