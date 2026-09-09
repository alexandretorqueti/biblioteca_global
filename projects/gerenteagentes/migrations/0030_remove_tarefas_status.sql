-- Migration: remover coluna status da tabela tarefas
-- O status agora é calculado dinamicamente pelo motor via fatos operacionais
-- (task_runtime_facts, subtarefas, bloqueios, etc.)
-- 
-- Data: 2026-09-09
-- Autor: Gerente de Agentes

-- Remove a coluna status da tabela tarefas
-- O status é derivado de fatos operacionais e não deve ser materializado
ALTER TABLE tarefas DROP COLUMN status;
