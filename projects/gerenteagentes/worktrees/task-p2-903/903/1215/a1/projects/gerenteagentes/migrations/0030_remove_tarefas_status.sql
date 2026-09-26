-- Migration: remover coluna status da tabela tarefas
-- O status agora é calculado dinamicamente pelo motor via fatos operacionais
-- (task_runtime_facts, subtarefas, bloqueios, etc.)
-- 
-- Data: 2026-09-09
-- Autor: Gerente de Agentes

-- Remove a coluna status da tabela tarefas, quando ela ainda existir. O
-- status é derivado de fatos operacionais e não deve ser materializado; a
-- guarda cobre bancos em que a remoção já ocorreu antes da consolidação do
-- journal de migrations.
SET @status_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tarefas'
    AND COLUMN_NAME = 'status'
);
SET @drop_status = IF(
  @status_exists > 0,
  'ALTER TABLE tarefas DROP COLUMN status',
  'SELECT 1'
);
PREPARE drop_status_stmt FROM @drop_status;
EXECUTE drop_status_stmt;
DEALLOCATE PREPARE drop_status_stmt;
