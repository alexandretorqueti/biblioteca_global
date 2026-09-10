-- Incidentes sistêmicos do Motor v2.
-- Agrupa falhas de infraestrutura por assinatura determinística
-- (classe da falha + serviço afetado + mensagem normalizada).
-- Um incidente pode impactar múltiplas tarefas; a janela temporal
-- evita agrupar falhas antigas com novas.
CREATE TABLE IF NOT EXISTS `motor_incidents` (
  `id` varchar(100) NOT NULL,
  `signature` varchar(500) NOT NULL,
  `failure_class` varchar(60) NOT NULL,
  `affected_service` varchar(30) NOT NULL,
  `normalized_message` varchar(300) NOT NULL,
  `diagnosis` text NOT NULL,
  `task_ids` json NOT NULL,
  `subtask_ids` json NOT NULL,
  `opened_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `resolved_at` timestamp NULL DEFAULT NULL,
  `occurrence_count` int unsigned NOT NULL DEFAULT 1,
  CONSTRAINT `motor_incidents_id` PRIMARY KEY(`id`),
  UNIQUE KEY `motor_incidents_signature_active` (`signature`, `resolved_at`),
  KEY `motor_incidents_class_idx` (`failure_class`, `opened_at`),
  KEY `motor_incidents_service_idx` (`affected_service`, `opened_at`),
  KEY `motor_incidents_open_idx` (`opened_at`)
);
