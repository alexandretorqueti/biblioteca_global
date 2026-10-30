-- DLQ deixa de ser buraco negro (incidentes 2026-09-25 / 2026-10-29):
-- arquivo de auditoria das mensagens mortas (re-enfileiradas ou descartadas
-- pelo DlqReconciler) + estado deduplicador do alerta de profundidade.
-- Idempotente de propósito: as duas pastas de migrations compartilham
-- __drizzle_migrations no banco do projeto (incidente task-p2-989) e o
-- bootstrap do motor-v3 aplica por hash — CREATE TABLE IF NOT EXISTS permite
-- rodar em qualquer ordem.
CREATE TABLE IF NOT EXISTS `motor_dlq_archive` (
  `id` bigint unsigned AUTO_INCREMENT PRIMARY KEY,
  `queue` varchar(120) NOT NULL,
  `family` varchar(30) NOT NULL,
  `message_type` varchar(80) NOT NULL,
  `message_id` varchar(120) NULL,
  `task_id` varchar(80) NULL,
  `block_id` bigint unsigned NULL,
  `death_count` int NOT NULL DEFAULT 0,
  `requeue_count` int NOT NULL DEFAULT 0,
  `decision` varchar(20) NOT NULL,
  `reason` varchar(120) NOT NULL,
  `payload_json` json NULL,
  `created_at` timestamp NOT NULL DEFAULT now(),
  INDEX `motor_dlq_archive_queue_idx` (`queue`),
  INDEX `motor_dlq_archive_task_idx` (`task_id`),
  INDEX `motor_dlq_archive_created_idx` (`created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `motor_dlq_alert_state` (
  `queue_name` varchar(120) PRIMARY KEY,
  `last_depth` int NOT NULL DEFAULT 0,
  `last_alert_at` timestamp NULL,
  `updated_at` timestamp NOT NULL DEFAULT now() ON UPDATE now()
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
