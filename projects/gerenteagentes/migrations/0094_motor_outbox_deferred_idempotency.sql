ALTER TABLE motor_outbox
  ADD COLUMN defer_count int NOT NULL DEFAULT 0 AFTER attempt,
  ADD UNIQUE KEY motor_outbox_logical_key_unique (type, task_id, correlation_id);
