-- Explicação estruturada da espera por limite, sem criar um novo status de tarefa.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN IF NOT EXISTS `capacity_wait_phase` enum('analysis','development') NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_reason_code` varchar(40) NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_limit_scope` enum('global','project','provider') NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_limit_value` int unsigned NULL,
  ADD COLUMN IF NOT EXISTS `capacity_wait_provider` varchar(120) NULL;
