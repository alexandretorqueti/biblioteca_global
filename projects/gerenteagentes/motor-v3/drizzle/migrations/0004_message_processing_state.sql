-- Adicionar tabela de rastreamento de processamento de mensagens para idempotência do consumidor
CREATE TABLE IF NOT EXISTS motor_message_processing_state (
    message_id VARCHAR(200) PRIMARY KEY,
    task_id VARCHAR(200) NULL,
    message_type VARCHAR(50) NOT NULL,
    status ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    attempt INT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    timeout_at DATETIME NULL,
    error_message TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Índices para performance nas consultas de estado e tarefa
CREATE INDEX IF NOT EXISTS idx_message_processing_state_status ON motor_message_processing_state(status, attempt);
CREATE INDEX IF NOT EXISTS idx_message_processing_state_task ON motor_message_processing_state(task_id, status);

SELECT 1 AS migration_applied;
