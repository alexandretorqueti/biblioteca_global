-- Migration: infrastructure_incidents
-- Cria tabelas para agrupamento determinístico de falhas sistêmicas de infraestrutura.
--
-- Cada incidente possui uma assinatura única (SHA-256 truncado) derivada de:
-- classe da falha + serviço afetado + mensagem normalizada.
-- A janela temporal (first_seen_at / last_seen_at) permite reutilização dentro de 7 dias.

CREATE TABLE IF NOT EXISTS `motor_infrastructure_incidents` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `incident_id` varchar(100) NOT NULL,
  `signature` varchar(40) NOT NULL,
  `failure_class` varchar(60) NOT NULL,
  `affected_service` varchar(30) NOT NULL,
  `normalized_message` varchar(300) NOT NULL DEFAULT '',
  `first_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `motor_infrastructure_incidents_id` PRIMARY KEY(`id`),
  UNIQUE KEY `motor_infrastructure_incidents_signature_uk` (`signature`),
  KEY `motor_infrastructure_incidents_incident_idx` (`incident_id`),
  KEY `motor_infrastructure_incidents_last_seen_idx` (`last_seen_at`)
);

-- Tarefas associadas a cada incidente (relação N:N).
CREATE TABLE IF NOT EXISTS `motor_infrastructure_incident_tasks` (
  `id` bigint unsigned AUTO_INCREMENT NOT NULL,
  `incident_id` varchar(100) NOT NULL,
  `tarefa_id` bigint unsigned NOT NULL,
  `associated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `motor_infrastructure_incident_tasks_id` PRIMARY KEY(`id`),
  UNIQUE KEY `motor_infrastructure_incident_tasks_uk` (`incident_id`, `tarefa_id`),
  KEY `motor_infrastructure_incident_tasks_tarefa_idx` (`tarefa_id`)
);

-- Adiciona colunas de assinatura e tipo de retomada ao histórico de recuperação.
-- Estas colunas complementam as existentes (original_reason, correction_applied)
-- com a assinatura determinística do incidente e o tipo de retomada.
ALTER TABLE `motor_infrastructure_recovery_history`
  ADD COLUMN `resume_type` varchar(20) NOT NULL DEFAULT 'automatic' AFTER `correction_applied`,
  ADD COLUMN `failure_signature` varchar(40) NULL AFTER `incident_id`;
