ALTER TABLE `motor_agent_sessions`
  ADD COLUMN `purpose` varchar(30) NOT NULL DEFAULT 'development' AFTER `status`,
  ADD KEY `motor_agent_sessions_purpose_status_idx` (`purpose`, `status`, `subtarefa_id`);
