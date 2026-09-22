-- Continuação segura do deploy event-driven após a publicação da migration 0061.

ALTER TABLE deploy_batches
  ADD COLUMN workspace_path VARCHAR(1000) NULL AFTER expected_commit,
  ADD COLUMN gate_job_id BIGINT UNSIGNED NULL AFTER workspace_path,
  ADD UNIQUE KEY deploy_batches_gate_job_unique (gate_job_id);
--> statement-breakpoint

INSERT INTO motor_actions (code,name,primitives_json,on_partial_failure,is_terminal,active)
VALUES ('A33_RECEIVE_DEPLOY_RESULT','Receber resultado do deploy', JSON_ARRAY(JSON_OBJECT('primitive','complete_deploy_batch_atomic')), 'mark_dirty', 0, 1)
ON DUPLICATE KEY UPDATE name=VALUES(name), primitives_json=VALUES(primitives_json), active=VALUES(active);
--> statement-breakpoint

INSERT INTO motor_commands (code,message_type,name,scope,handler_code,active,version)
VALUES ('C13_DEPLOY_BATCH_RESULT_RECEIVED','DEPLOY_BATCH_RESULT_RECEIVED','Resultado remoto de deploy recebido','projeto','deploy_result',1,1)
ON DUPLICATE KEY UPDATE name=VALUES(name), active=VALUES(active), version=VALUES(version);
--> statement-breakpoint

INSERT INTO motor_command_policies (command_id,code,name,priority,conditions_json,action_id,active,version)
SELECT c.id,'P13_ACCEPT_DEPLOY_RESULT','Aceitar resultado remoto de lote',100,JSON_OBJECT('all',JSON_ARRAY()),a.id,1,1 FROM motor_commands c JOIN motor_actions a ON a.code='A33_RECEIVE_DEPLOY_RESULT' WHERE c.code='C13_DEPLOY_BATCH_RESULT_RECEIVED'
ON DUPLICATE KEY UPDATE name=VALUES(name),action_id=VALUES(action_id),conditions_json=VALUES(conditions_json),active=VALUES(active);
