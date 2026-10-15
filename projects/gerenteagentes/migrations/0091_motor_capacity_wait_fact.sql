-- Fato observável de espera por capacidade. O status da tarefa continua sendo
-- derivado dos fatos existentes; estas colunas apenas explicam por que a
-- próxima ação ainda não foi iniciada.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN IF NOT EXISTS `capacity_wait_phase` enum('analysis','development') NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_reason_code` varchar(40) NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_limit_scope` enum('global','project','provider') NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_limit_value` int unsigned NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_provider` varchar(120) NULL;

