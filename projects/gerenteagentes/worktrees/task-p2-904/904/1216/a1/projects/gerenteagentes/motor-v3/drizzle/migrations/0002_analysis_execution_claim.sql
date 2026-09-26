-- Identifica qual execução possui o claim da análise.
-- Sem este vínculo, uma recuperação poderia liberar o claim de outra análise.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN IF NOT EXISTS `analysis_execution_id` varchar(200) NULL AFTER `analysis_started_at`;

CREATE INDEX `task_runtime_facts_analysis_execution_idx`
  ON `task_runtime_facts` (`analysis_execution_id`);
