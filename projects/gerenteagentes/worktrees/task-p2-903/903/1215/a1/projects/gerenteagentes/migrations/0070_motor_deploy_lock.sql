-- Deploy lock: garante atomicidade do deploy blue-green.
-- O DeployConsumer adquire o lock antes de iniciar o deploy; consumidores
-- de análise/subtarefa verificam o lock antes de aceitar trabalho novo.
--
-- Tabela singleton (id DEFAULT 1) para lock exclusivo por instância de banco.
-- Idempotente: CREATE TABLE IF NOT EXISTS + INSERT IGNORE.

CREATE TABLE IF NOT EXISTS motor_deploy_lock (
  id INT PRIMARY KEY DEFAULT 1,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMP NULL,
  locked_by VARCHAR(200) NULL,
  reason VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Garante a linha singleton para consultas diretas (sem INSERT prévio).
INSERT IGNORE INTO motor_deploy_lock (id, locked) VALUES (1, FALSE);
