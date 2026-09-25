-- Adjustments generations: suporte a múltiplas generations de tarefas via chat.
-- Adiciona colunas generation em subtarefas e deploy_requests, altera constraint UNIQUE
-- de deploy_requests para (tarefa_id, generation), e registra o comando
-- TASK_ADJUSTMENT_REQUESTED com política e ação associadas.
--
-- Idempotente: segura para deploy blue/green e reaplicação controlada.

-- ============================================================================
-- 1. Coluna `generation` em `subtarefas` (INT NOT NULL DEFAULT 1)
-- ============================================================================
SET @db_name = DATABASE();

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db_name AND table_name = 'subtarefas' AND column_name = 'generation'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `subtarefas` ADD COLUMN `generation` INT NOT NULL DEFAULT 1',
  'SELECT 1 AS subtarefas_generation_already_exists'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- 2. Coluna `generation` em `deploy_requests` (INT NOT NULL DEFAULT 1)
-- ============================================================================
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db_name AND table_name = 'deploy_requests' AND column_name = 'generation'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `deploy_requests` ADD COLUMN `generation` INT NOT NULL DEFAULT 1',
  'SELECT 1 AS deploy_requests_generation_already_exists'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- 3. Coluna `parent_generation` em `deploy_requests` (INT NULL)
-- ============================================================================
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db_name AND table_name = 'deploy_requests' AND column_name = 'parent_generation'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `deploy_requests` ADD COLUMN `parent_generation` INT NULL',
  'SELECT 1 AS deploy_requests_parent_generation_already_exists'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- 4. Constraint UNIQUE de deploy_requests: (tarefa_id) → (tarefa_id, generation)
-- ============================================================================
-- Drop seguro: só remove se o index antigo existir
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db_name AND table_name = 'deploy_requests' AND index_name = 'deploy_requests_tarefa_unique'
);
SET @sql = IF(@idx_exists > 0,
  'ALTER TABLE `deploy_requests` DROP INDEX `deploy_requests_tarefa_unique`',
  'SELECT 1 AS deploy_requests_tarefa_unique_already_dropped'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add seguro: só cria se o index novo não existir
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db_name AND table_name = 'deploy_requests' AND index_name = 'deploy_requests_tarefa_generation_unique'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `deploy_requests` ADD UNIQUE INDEX `deploy_requests_tarefa_generation_unique` (`tarefa_id`, `generation`)',
  'SELECT 1 AS deploy_requests_tarefa_generation_unique_already_exists'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================================
-- 5. Governança: comando TASK_ADJUSTMENT_REQUESTED
-- ============================================================================

-- Primitiva: registrar solicitação de ajuste
INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'register_adjustment_request', 'Registrar solicitação de ajuste', 'db', 'Persiste a solicitação de ajuste e prepara a sessão de análise para a nova generation.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'register_adjustment_request');
--> statement-breakpoint

-- Primitiva: iniciar analista para ajuste
INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'start_adjustment_analyst', 'Iniciar analista para ajuste', 'control', 'Dispara o runner de análise com contexto da geração anterior e mensagem de ajuste.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'start_adjustment_analyst');
--> statement-breakpoint

-- Ação A40_ACCEPT_ADJUSTMENT_REQUEST
INSERT INTO `motor_actions` (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A40_ACCEPT_ADJUSTMENT_REQUEST', 'Aceitar solicitação de ajuste',
  JSON_ARRAY(
    JSON_OBJECT('primitive', 'register_adjustment_request'),
    JSON_OBJECT('primitive', 'start_adjustment_analyst')
  ),
  'continue', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A40_ACCEPT_ADJUSTMENT_REQUEST');
--> statement-breakpoint

-- Comando C20_TASK_ADJUSTMENT_REQUESTED
INSERT INTO `motor_commands` (`code`, `message_type`, `name`, `scope`, `handler_code`, `active`, `version`)
VALUES ('C20_TASK_ADJUSTMENT_REQUESTED', 'TASK_ADJUSTMENT_REQUESTED', 'Ajuste incremental de tarefa solicitado', 'tarefa', 'motor-v3:adjustment', 1, 1)
ON DUPLICATE KEY UPDATE
  `message_type` = VALUES(`message_type`), `name` = VALUES(`name`), `scope` = VALUES(`scope`),
  `handler_code` = VALUES(`handler_code`), `active` = VALUES(`active`);
--> statement-breakpoint

-- Política P20_ACCEPT_ADJUSTMENT_REQUEST
INSERT INTO `motor_command_policies`
  (`command_id`, `code`, `name`, `priority`, `conditions_json`, `action_id`, `active`, `version`)
SELECT c.id, 'P20_ACCEPT_ADJUSTMENT_REQUEST', 'Aceitar ajuste quando tarefa estiver deployada ou concluída', 100,
  JSON_OBJECT('all', JSON_ARRAY('task_deployed_or_completed')),
  a.id, 1, 1
FROM `motor_commands` c
INNER JOIN `motor_actions` a ON a.code = 'A40_ACCEPT_ADJUSTMENT_REQUEST'
WHERE c.code = 'C20_TASK_ADJUSTMENT_REQUESTED'
  AND NOT EXISTS (SELECT 1 FROM `motor_command_policies` WHERE `code` = 'P20_ACCEPT_ADJUSTMENT_REQUEST');
