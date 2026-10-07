-- Sessões de agente com propósito explícito: 'development' (padrão) ou
-- 'baseline_fix' (sessões abertas pelo BaselinePreflightRecovery). A coluna é
-- lida por DevelopmentSessionRecoveryReconciler (mas.purpose) e pelo upsert em
-- start.ts. Originária de task-p2-948: o arquivo foi criado em
-- projects/gerenteagentes/migrations/0075_motor_baseline_fix_sessions.sql, mas
-- sem entrada no journal da plataforma (órfã, nunca aplicada). Movida para as
-- migrations runtime do motor-v3, que têm tracking próprio por hash.
SET NAMES utf8mb4;

ALTER TABLE `motor_agent_sessions`
  ADD COLUMN `purpose` varchar(30) NOT NULL DEFAULT 'development' AFTER `status`,
  ADD KEY `motor_agent_sessions_purpose_status_idx` (`purpose`, `status`, `subtarefa_id`);
