-- Migration: Adicionar fases de deploy ao enum da coluna phase em motor_operation_log
-- Data: 2026-09-26
-- Descrição: O DeployConsumer usa fases específicas para deploy que não estavam no enum original

ALTER TABLE motor_operation_log 
MODIFY COLUMN phase ENUM(
  'received', 'decision', 'action', 'primitive', 'completed', 'failed', 'rejected',
  'deploy_lock_acquired', 'deploy_wait_completed', 'forced_pause_for_deploy', 'deploy_lock_released'
) NOT NULL;
