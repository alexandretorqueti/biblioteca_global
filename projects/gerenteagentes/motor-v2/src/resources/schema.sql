-- Schema para Motor v2 - Sistema de Paralelismo
-- Executar no banco projeto_640

-- Tabela de recursos e leases
CREATE TABLE IF NOT EXISTS execution_resources (
  resource_key VARCHAR(255) PRIMARY KEY,
  execution_id VARCHAR(100) NOT NULL,
  owner_id VARCHAR(100) NOT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 1,
  heartbeat_at DATETIME(6) NOT NULL,
  acquired_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  max_wait_seconds INT NOT NULL DEFAULT 300,
  INDEX idx_expires (expires_at),
  INDEX idx_execution (execution_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabela de fila de espera por recursos
CREATE TABLE IF NOT EXISTS execution_resource_queue (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  resource_key VARCHAR(255) NOT NULL,
  execution_id VARCHAR(100) NOT NULL,
  owner_id VARCHAR(100) NOT NULL,
  requested_at DATETIME(6) NOT NULL,
  status ENUM('waiting', 'granted', 'expired') NOT NULL DEFAULT 'waiting',
  INDEX idx_resource_status (resource_key, status),
  INDEX idx_requested (requested_at),
  FOREIGN KEY (resource_key) REFERENCES execution_resources(resource_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Adiciona colunas de execução à tabela tarefas (se não existirem)
-- Nota: MySQL não suporta IF NOT EXISTS em ALTER TABLE diretamente,
-- então usamos procedures ou verificamos antes

-- Colunas para controle de execução paralela
ALTER TABLE projeto_640.tarefas 
  ADD COLUMN IF NOT EXISTS execution_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS fencing_token BIGINT,
  ADD COLUMN IF NOT EXISTS resource_wait_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS resource_wait_id BIGINT,
  ADD COLUMN IF NOT EXISTS resource_wait_position INT,
  ADD COLUMN IF NOT EXISTS paused_at DATETIME(6);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_tarefas_execution ON projeto_640.tarefas(execution_id);
CREATE INDEX IF NOT EXISTS idx_tarefas_paused ON projeto_640.tarefas(status, resource_wait_key);

-- Colunas para subtarefas paralelas (Etapa 9)
ALTER TABLE projeto_640.subtarefas 
  ADD COLUMN IF NOT EXISTS depends_on_subtask_ids JSON;

CREATE INDEX IF NOT EXISTS idx_subtarefas_task_status ON projeto_640.subtarefas(task_id, status);
