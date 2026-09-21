-- Correlação e auditoria das sessões de análise do Motor v3.
-- As tabelas base existem desde 0028; estes campos permitem distinguir
-- redelivery da fila, tentativa de modelo, fase e resposta observada.
ALTER TABLE analyst_task_sessions
  ADD COLUMN analysis_execution_id VARCHAR(200) NULL AFTER execution_order,
  ADD COLUMN analysis_attempt_id VARCHAR(100) NULL AFTER analysis_execution_id,
  ADD COLUMN model_attempt INT NOT NULL DEFAULT 1 AFTER analysis_attempt_id,
  ADD KEY analyst_task_sessions_execution_idx (analysis_execution_id, analysis_attempt_id);
--> statement-breakpoint

ALTER TABLE analyst_task_session_messages
  ADD COLUMN phase VARCHAR(40) NULL AFTER role,
  ADD COLUMN run_id VARCHAR(300) NULL AFTER phase,
  ADD KEY analyst_task_session_messages_run_idx (run_id);
--> statement-breakpoint

ALTER TABLE motor_agent_session_failures
  ADD COLUMN analysis_execution_id VARCHAR(200) NULL AFTER runtime_session_id,
  ADD COLUMN analysis_attempt_id VARCHAR(100) NULL AFTER analysis_execution_id,
  ADD COLUMN phase VARCHAR(40) NULL AFTER analysis_attempt_id,
  ADD KEY motor_agent_session_failures_execution_idx (analysis_execution_id, analysis_attempt_id);
