-- 0030: Chat author tracking and enriched transition audit
-- Subtarefa 9: Persistir histórico completo e auditoria de transições

-- Adiciona coluna author ao tarefa_chats para rastrear quem enviou a mensagem
-- (ex.: "alexandre", "analyst-gpt4", "system"). NULL para mensagens legadas.
ALTER TABLE tarefa_chats
  ADD COLUMN author VARCHAR(200) DEFAULT NULL AFTER role;

-- Cria índice para consultas por author (auditoria)
CREATE INDEX idx_tarefa_chats_author ON tarefa_chats (tarefa_id, author);

-- Tabela de auditoria enriquecida de transições
-- Captura o contexto completo de cada transição: sessão ativa, proposta envolvida,
-- decisão do usuário, e metadados da conversa. Permite reconstruir o histórico
-- completo de uma tarefa após reinício do motor.
CREATE TABLE IF NOT EXISTS motor_task_transition_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tarefa_id BIGINT UNSIGNED NOT NULL,
  transition VARCHAR(50) NOT NULL,
  status_anterior VARCHAR(50) NOT NULL,
  status_novo VARCHAR(50) NOT NULL,

  -- Contexto da sessão do analista (se aplicável)
  analyst_session_id BIGINT UNSIGNED DEFAULT NULL,

  -- Contexto da proposta de plano (se aplicável)
  plan_proposal_id BIGINT UNSIGNED DEFAULT NULL,
  plan_proposal_version INT UNSIGNED DEFAULT NULL,

  -- Contexto da decisão do usuário (se aplicável)
  decision_type VARCHAR(30) DEFAULT NULL,
  decision_actor VARCHAR(200) DEFAULT NULL,
  decision_reason TEXT DEFAULT NULL,

  -- Metadados da execução (se aplicável)
  execution_id VARCHAR(200) DEFAULT NULL,
  worker_id VARCHAR(200) DEFAULT NULL,

  -- Mensagem/chat context (última mensagem antes da transição)
  last_chat_message_id BIGINT UNSIGNED DEFAULT NULL,

  -- Motivo/erro (compatível com tarefas_status_historico)
  motivo VARCHAR(500) DEFAULT NULL,

  -- Timestamps
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Constraints
  CONSTRAINT fk_transition_audit_task FOREIGN KEY (tarefa_id) REFERENCES tarefas(id) ON DELETE CASCADE,
  CONSTRAINT fk_transition_audit_session FOREIGN KEY (analyst_session_id) REFERENCES motor_task_analyst_sessions(id) ON DELETE SET NULL,
  CONSTRAINT fk_transition_audit_proposal FOREIGN KEY (plan_proposal_id) REFERENCES motor_plan_proposals(id) ON DELETE SET NULL,
  KEY idx_transition_audit_task_occurred (tarefa_id, occurred_at),
  KEY idx_transition_audit_transition (transition, occurred_at),
  KEY idx_transition_audit_session (analyst_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
