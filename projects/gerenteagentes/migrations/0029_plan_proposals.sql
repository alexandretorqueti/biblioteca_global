-- 0029: Plan proposals — separa a proposta de plano da materialização de subtarefas.
-- O analista apresenta uma proposta (status: proposed); o dono aprova (approved)
-- ou pede ajustes (rejected). Subtarefas só são criadas após aprovação explícita.

CREATE TABLE IF NOT EXISTS motor_plan_proposals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tarefa_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  status ENUM('proposed', 'approved', 'rejected') NOT NULL DEFAULT 'proposed',
  subtasks_json JSON NOT NULL,
  coverage_json JSON NOT NULL,
  proposed_at DATETIME NOT NULL,
  decided_at DATETIME DEFAULT NULL,
  decided_by VARCHAR(120) DEFAULT NULL,
  decision_reason TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_version (tarefa_id, version),
  KEY idx_task_status (tarefa_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
