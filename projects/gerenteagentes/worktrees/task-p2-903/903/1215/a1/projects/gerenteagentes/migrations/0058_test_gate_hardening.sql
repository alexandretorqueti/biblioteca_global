ALTER TABLE test_runs
  ADD COLUMN environment_json JSON NULL AFTER environment_fingerprint,
  ADD COLUMN stdout_artifact_path TEXT NULL AFTER stderr,
  ADD COLUMN stderr_artifact_path TEXT NULL AFTER stdout_artifact_path,
  ADD COLUMN reused_from_run_id BIGINT UNSIGNED NULL AFTER baseline_run_id,
  ADD KEY idx_test_runs_reused_from (reused_from_run_id),
  ADD CONSTRAINT fk_test_runs_reused_from FOREIGN KEY (reused_from_run_id) REFERENCES test_runs(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE test_recovery_attempts
  MODIFY COLUMN status ENUM('pending','running','resolved','failed','awaiting_user') NOT NULL DEFAULT 'pending',
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 2 AFTER attempt_count;
