-- Migration 0028: V4/V5 coesão arquitetural e dependências múltiplas
-- Estado: coluna adicionada, contrato V4 ativo, prompts V5 ativos (IDs 18, 19)

-- Adicionar coluna de dependências múltiplas (idempotente)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subtarefas' AND COLUMN_NAME = 'depends_on_subtask_ids');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `subtarefas` ADD COLUMN `depends_on_subtask_ids` json NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Migrar dados da coluna antiga (idempotente)
UPDATE `subtarefas`
SET `depends_on_subtask_ids` = CASE
  WHEN `depends_on_subtask_id` IS NULL THEN JSON_ARRAY()
  ELSE JSON_ARRAY(`depends_on_subtask_id`)
END
WHERE `depends_on_subtask_ids` IS NULL;

-- Contrato V4 já existe e está ativo (versao_ativa_id=6)
-- Prompts V5 já foram criados e ativados (IDs 18, 19)
-- Esta migration agora é apenas documentação do estado atual
