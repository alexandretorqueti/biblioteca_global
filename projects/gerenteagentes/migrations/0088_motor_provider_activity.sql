-- Provider reservado pela atividade. NULL preserva o comportamento legado
-- quando não há provider/configuração aplicável.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN `provider` varchar(100) NULL AFTER `analysis_execution_id`,
  ADD KEY `task_runtime_facts_provider_analysis_idx` (`provider`, `analysis_started_at`);
ALTER TABLE `subtarefas`
  ADD COLUMN `provider` varchar(100) NULL AFTER `status`,
  ADD KEY `subtarefas_provider_status_idx` (`provider`, `status`);
ALTER TABLE `motor_active_executions`
  ADD COLUMN `provider` varchar(100) NULL AFTER `phase`,
  ADD KEY `motor_active_executions_provider_phase_idx` (`provider`, `phase`, `expires_at`);
