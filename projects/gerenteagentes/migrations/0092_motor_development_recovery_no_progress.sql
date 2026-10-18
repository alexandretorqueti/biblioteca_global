ALTER TABLE `motor_agent_sessions`
  ADD COLUMN `no_progress_touch_count` int unsigned NOT NULL DEFAULT 0 AFTER `last_activity_at`;
