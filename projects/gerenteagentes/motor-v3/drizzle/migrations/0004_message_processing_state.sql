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
SET @status_index_exists = (
    SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'motor_message_processing_state'
       AND index_name = 'idx_message_processing_state_status'
);
SET @status_index_sql = IF(
    @status_index_exists = 0,
    'CREATE INDEX idx_message_processing_state_status ON motor_message_processing_state(status, attempt)',
    'SELECT 1'
);
PREPARE status_index_stmt FROM @status_index_sql;
EXECUTE status_index_stmt;
DEALLOCATE PREPARE status_index_stmt;

SET @task_index_exists = (
    SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'motor_message_processing_state'
       AND index_name = 'idx_message_processing_state_task'
);
SET @task_index_sql = IF(
    @task_index_exists = 0,
    'CREATE INDEX idx_message_processing_state_task ON motor_message_processing_state(task_id, status)',
    'SELECT 1'
);
PREPARE task_index_stmt FROM @task_index_sql;
EXECUTE task_index_stmt;
DEALLOCATE PREPARE task_index_stmt;

SELECT 1 AS migration_applied;
