-- Deploy event-driven do Motor v3. Mantém deploy_requests como fonte de verdade por tarefa.

ALTER TABLE deploy_requests
  ADD COLUMN requested_commit VARCHAR(64) NULL AFTER repo_path,
  ADD COLUMN base_branch VARCHAR(255) NULL AFTER requested_commit;
--> statement-breakpoint

CREATE TABLE deploy_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id VARCHAR(100) NOT NULL,
  repo_path VARCHAR(1000) NOT NULL,
  base_branch VARCHAR(255) NOT NULL,
  expected_commit VARCHAR(64) NOT NULL,
  status ENUM('pending','running','succeeded','failed') NOT NULL DEFAULT 'pending',
  remote_pid VARCHAR(64) NULL,
  remote_status_path VARCHAR(1000) NULL,
  last_error TEXT NULL,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY deploy_batches_batch_unique (batch_id),
  KEY deploy_batches_repository_status_idx (repo_path(255), status),
  KEY deploy_batches_status_started_idx (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE INDEX deploy_requests_repository_commit_status_idx ON deploy_requests (repo_path(255), base_branch, requested_commit, status);
--> statement-breakpoint

INSERT INTO motor_primitives (code,name,domain,description) VALUES
  ('run_pre_deploy_gate','Executar gate pre_deploy','control','Executa e persiste o gate contra o commit de integração.'),
  ('upsert_deploy_request','Persistir solicitação de deploy','db','Cria ou atualiza a solicitação e o comando de dispatch no outbox.'),
  ('claim_deploy_batch_atomic','Adquirir lote atômico de deploy','db','Agrupa solicitações compatíveis e impede concorrência por repositório.'),
  ('promote_commit_to_base','Promover commit para a branch-base','git','Promove em worktree isolado e publica a branch-base.'),
  ('start_remote_blue_green','Iniciar blue-green remoto','control','Inicia o script remoto e persiste identificadores de reconciliação.'),
  ('complete_deploy_batch_atomic','Concluir lote de deploy','db','Confirma sucesso e emite eventos por tarefa.'),
  ('fail_deploy_batch_atomic','Falhar lote de deploy','db','Registra falha, bloqueia tarefas e emite eventos por tarefa.')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);
--> statement-breakpoint

INSERT INTO motor_actions (code,name,primitives_json,on_partial_failure,is_terminal,active) VALUES
  ('A30_ACCEPT_DEPLOY_REQUEST','Aceitar solicitação de deploy', JSON_ARRAY(JSON_OBJECT('primitive','run_pre_deploy_gate'),JSON_OBJECT('primitive','upsert_deploy_request')), 'mark_dirty', 0, 1),
  ('A31_DISPATCH_DEPLOY_BATCH','Executar lote de deploy', JSON_ARRAY(JSON_OBJECT('primitive','claim_deploy_batch_atomic'),JSON_OBJECT('primitive','promote_commit_to_base'),JSON_OBJECT('primitive','start_remote_blue_green')), 'mark_dirty', 0, 1),
  ('A32_RECONCILE_DEPLOY_BATCH','Reconciliar lote de deploy', JSON_ARRAY(JSON_OBJECT('primitive','complete_deploy_batch_atomic')), 'mark_dirty', 0, 1)
ON DUPLICATE KEY UPDATE name=VALUES(name), primitives_json=VALUES(primitives_json), active=VALUES(active);
--> statement-breakpoint

INSERT INTO motor_commands (code,message_type,name,scope,handler_code,active,version) VALUES
  ('C10_DEPLOY_REQUESTED','DEPLOY_REQUESTED','Deploy de tarefa solicitado','tarefa','deploy_request',1,1),
  ('C11_DEPLOY_BATCH_DISPATCH_REQUESTED','DEPLOY_BATCH_DISPATCH_REQUESTED','Despacho de lote de deploy','projeto','deploy_dispatch',1,1),
  ('C12_DEPLOY_RECONCILIATION_REQUESTED','DEPLOY_RECONCILIATION_REQUESTED','Reconciliação de lote de deploy','projeto','deploy_reconcile',1,1)
ON DUPLICATE KEY UPDATE name=VALUES(name), active=VALUES(active), version=VALUES(version);
--> statement-breakpoint

INSERT INTO motor_command_policies (command_id,code,name,priority,conditions_json,action_id,active,version)
SELECT c.id,'P10_DEPLOY_IF_ELIGIBLE','Aceitar deploy de tarefa integrada e concluída',100,JSON_OBJECT('all',JSON_ARRAY()),a.id,1,1 FROM motor_commands c JOIN motor_actions a ON a.code='A30_ACCEPT_DEPLOY_REQUEST' WHERE c.code='C10_DEPLOY_REQUESTED'
ON DUPLICATE KEY UPDATE name=VALUES(name),action_id=VALUES(action_id),conditions_json=VALUES(conditions_json),active=VALUES(active);
--> statement-breakpoint

INSERT INTO motor_command_policies (command_id,code,name,priority,conditions_json,action_id,active,version)
SELECT c.id,'P11_DISPATCH_DEPLOY_BATCH','Despachar lote de deploy',100,JSON_OBJECT('all',JSON_ARRAY()),a.id,1,1 FROM motor_commands c JOIN motor_actions a ON a.code='A31_DISPATCH_DEPLOY_BATCH' WHERE c.code='C11_DEPLOY_BATCH_DISPATCH_REQUESTED'
ON DUPLICATE KEY UPDATE name=VALUES(name),action_id=VALUES(action_id),conditions_json=VALUES(conditions_json),active=VALUES(active);
--> statement-breakpoint

INSERT INTO motor_command_policies (command_id,code,name,priority,conditions_json,action_id,active,version)
SELECT c.id,'P12_RECONCILE_DEPLOY_BATCH','Reconciliar lote remoto',100,JSON_OBJECT('all',JSON_ARRAY()),a.id,1,1 FROM motor_commands c JOIN motor_actions a ON a.code='A32_RECONCILE_DEPLOY_BATCH' WHERE c.code='C12_DEPLOY_RECONCILIATION_REQUESTED'
ON DUPLICATE KEY UPDATE name=VALUES(name),action_id=VALUES(action_id),conditions_json=VALUES(conditions_json),active=VALUES(active);
