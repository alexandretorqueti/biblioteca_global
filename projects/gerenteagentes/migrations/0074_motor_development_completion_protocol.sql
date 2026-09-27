ALTER TABLE `motor_agent_sessions`
  ADD COLUMN `completion_nudge_count` int unsigned NOT NULL DEFAULT 0 AFTER `last_activity_at`,
  ADD COLUMN `completion_nudged_at` timestamp NULL AFTER `completion_nudge_count`;
