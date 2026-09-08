-- Rollback manual da migration 0026.
-- Executar somente após exportar/arquivar os dados de observabilidade.
DROP TABLE IF EXISTS `gate_runs`;
DROP TABLE IF EXISTS `execution_events`;
DROP TABLE IF EXISTS `execution_attempts`;
ALTER TABLE `bloqueios`
  DROP INDEX `idx_bloqueios_recurrence_fingerprint`,
  DROP INDEX `idx_bloqueios_tarefa_status_date`,
  DROP COLUMN `recurrence_fingerprint`, DROP COLUMN `resolution`,
  DROP COLUMN `root_cause`, DROP COLUMN `owner_id`, DROP COLUMN `severity`,
  DROP COLUMN `category`, DROP COLUMN `resolved_at`;
ALTER TABLE `subtarefas`
  DROP COLUMN `verified_at`, DROP COLUMN `baseline_version`,
  DROP COLUMN `critical_path`, DROP COLUMN `priority`,
  DROP COLUMN `estimated_effort_minutes`, DROP COLUMN `planned_end`,
  DROP COLUMN `planned_start`, DROP COLUMN `weight`;
ALTER TABLE `tarefas`
  DROP COLUMN `customer_impact`, DROP COLUMN `incident_id`, DROP COLUMN `rollback_at`,
  DROP COLUMN `smoke_test_ok`, DROP COLUMN `smoke_test_at`, DROP COLUMN `deployed_at`,
  DROP COLUMN `baseline_version`, DROP COLUMN `critical_path`, DROP COLUMN `priority`,
  DROP COLUMN `estimated_effort_minutes`, DROP COLUMN `planned_end`,
  DROP COLUMN `planned_start`, DROP COLUMN `weight`;
