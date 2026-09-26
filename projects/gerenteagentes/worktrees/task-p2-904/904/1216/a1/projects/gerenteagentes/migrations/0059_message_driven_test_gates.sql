ALTER TABLE motor_outbox
  ADD COLUMN destination_queue VARCHAR(255) NOT NULL DEFAULT 'motor.commands' AFTER type,
  ADD KEY idx_motor_outbox_destination_status (destination_queue, status, id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS test_gate_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_message_id VARCHAR(100) NOT NULL,
  completion_message_id VARCHAR(100) NULL,
  tarefa_id BIGINT UNSIGNED NOT NULL,
  subtarefa_id BIGINT UNSIGNED NULL,
  phase ENUM('baseline','post_dev','rework','monitor_recovery','pre_deploy') NOT NULL,
  status ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  input_json JSON NOT NULL,
  test_run_id BIGINT UNSIGNED NULL,
  result_json JSON NULL,
  error_message TEXT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_test_gate_jobs_request (request_message_id),
  KEY idx_test_gate_jobs_status (status, created_at),
  KEY idx_test_gate_jobs_task (tarefa_id, created_at),
  CONSTRAINT fk_test_gate_jobs_run FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE SET NULL
);
