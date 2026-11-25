-- Tarefa task-p2-1116 (exibição do modelo em uso): presença do modelo de IA da
-- execução vigente. NULL preserva o comportamento legado quando não há modelo
-- conhecido no registro (a leitura usa COALESCE(ats.model, mas.model, e.model)).
-- Fonte primária para Monitor/pos-deploy, que não gravam sessões em
-- analyst_task_sessions/motor_agent_sessions (motor_agent_sessions.subtarefa_id
-- é NOT NULL e missões do Monitor podem não ter subtarefa).
ALTER TABLE `motor_active_executions`
  ADD COLUMN `model` varchar(200) NULL AFTER `provider`;
