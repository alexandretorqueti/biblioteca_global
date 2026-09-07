DROP TABLE IF EXISTS `gate_runs`;
DROP TABLE IF EXISTS `execution_events`;
DROP TABLE IF EXISTS `execution_attempts`;

ALTER TABLE `bloqueios`
  DROP INDEX `bloqueios_subtask_status_idx`, DROP INDEX `bloqueios_recurrence_idx`;
ALTER TABLE `subtarefas`
  DROP INDEX `subtarefas_baseline_period_idx`, DROP INDEX `subtarefas_deploy_smoke_idx`;
ALTER TABLE `tarefas`
  DROP INDEX `tarefas_baseline_period_idx`;

ALTER TABLE `bloqueios`
  DROP COLUMN `status`, DROP COLUMN `category`, DROP COLUMN `severity`, DROP COLUMN `owner_id`,
  DROP COLUMN `root_cause`, DROP COLUMN `resolution`, DROP COLUMN `resolved_at`, DROP COLUMN `recurrence_fingerprint`;

ALTER TABLE `subtarefas`
  DROP COLUMN `weight`, DROP COLUMN `planned_start`, DROP COLUMN `planned_end`, DROP COLUMN `estimated_effort_minutes`,
  DROP COLUMN `priority`, DROP COLUMN `critical_path`, DROP COLUMN `baseline_version`, DROP COLUMN `verified_at`,
  DROP COLUMN `deployed_at`, DROP COLUMN `smoke_test_at`, DROP COLUMN `smoke_test_ok`, DROP COLUMN `rollback_at`,
  DROP COLUMN `incident_id`, DROP COLUMN `customer_impact`;

ALTER TABLE `tarefas`
  DROP COLUMN `weight`, DROP COLUMN `planned_start`, DROP COLUMN `planned_end`, DROP COLUMN `estimated_effort_minutes`,
  DROP COLUMN `priority`, DROP COLUMN `critical_path`, DROP COLUMN `baseline_version`;
