-- Auditoria append-only da reanálise de bloqueios sistêmicos.
CREATE TABLE IF NOT EXISTS `motor_infrastructure_recovery_history` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `subtarefa_id` bigint unsigned NOT NULL,
  `incident_id` varchar(100) NOT NULL,
  `original_reason` varchar(500) NOT NULL,
  `correction_applied` varchar(1000) NOT NULL,
  `resumed_by` varchar(120) NOT NULL,
  `execution_id` varchar(200) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `motor_infrastructure_recovery_history_id` PRIMARY KEY(`id`),
  KEY `motor_infrastructure_recovery_task_idx` (`tarefa_id`, `created_at`),
  KEY `motor_infrastructure_recovery_incident_idx` (`incident_id`)
);
