-- Adiciona coluna resume_type para distinguir ação manual de automática na trilha de retomada.
ALTER TABLE `motor_infrastructure_recovery_history`
  ADD COLUMN `resume_type` enum('manual','automatic') NOT NULL DEFAULT 'automatic' AFTER `correction_applied`;
