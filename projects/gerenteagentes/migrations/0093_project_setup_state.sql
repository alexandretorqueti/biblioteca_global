ALTER TABLE `projetos_captados`
  ADD COLUMN `setup_status` enum('pending','queued','running','verified','failed','blocked') NOT NULL DEFAULT 'pending' AFTER `plataforma_projeto_id`,
  ADD COLUMN `setup_error` text NULL AFTER `setup_status`,
  ADD COLUMN `setup_attempts` int NOT NULL DEFAULT 0 AFTER `setup_error`,
  ADD COLUMN `setup_last_attempt_at` datetime NULL AFTER `setup_attempts`,
  ADD COLUMN `setup_verified_at` datetime NULL AFTER `setup_last_attempt_at`,
  ADD COLUMN `setup_evidence` json NULL AFTER `setup_verified_at`;
