-- Governança do catálogo de decisões do Motor v3.
-- Migration aditiva: preserva linhas e IDs existentes.
SET NAMES utf8mb4;

ALTER TABLE motor_actions
  ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER is_terminal;

ALTER TABLE motor_reactions
  ADD COLUMN condition_json JSON NULL AFTER params_json,
  ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER condition_json;

-- Ações terminais são a barreira de segurança comum para as regras de erro.
UPDATE motor_actions
SET is_terminal = 1, version = COALESCE(version, 1)
WHERE code = 'A03_BLOCK';

-- Eventos novos para os pontos H1/H6/H10/H12-H18 ainda não cobertos pelo
-- catálogo original. ON DUPLICATE KEY torna o seed repetível por código.
INSERT INTO motor_events (code, name, category, scope, priority, active) VALUES
  ('E36_DEPLOY_FAILED', 'Falha de Deploy', 'erro', 'tarefa', 410, 1),
  ('E37_WORKER_EXHAUSTED', 'Tentativas do Worker Esgotadas', 'erro', 'subtarefa', 420, 1),
  ('E38_QUEUE_DLQ', 'Mensagem Enviada para DLQ', 'erro', 'global', 430, 1),
  ('E39_BASELINE_RED', 'Baseline Vermelho', 'erro', 'subtarefa', 440, 1),
  ('E40_PROMOTION_CONFLICT', 'Conflito de Promoção', 'erro', 'tarefa', 450, 1),
  ('E41_ANALYSIS_FAILED', 'Falha Definitiva de Análise', 'erro', 'tarefa', 460, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), category = VALUES(category), scope = VALUES(scope),
  priority = VALUES(priority), active = 1;

-- Padrões são inseridos somente quando a combinação ainda não existe; não há
-- DELETE nem alteração de padrões editados por humanos.
INSERT INTO motor_patterns (event_id, pattern, match_type, match_target, active)
SELECT e.id, p.pattern, p.match_type, p.match_target, 1
FROM motor_events e
JOIN (
  SELECT 'E36_DEPLOY_FAILED' AS event_code, 'script blue-green' AS pattern, 'contains' AS match_type, 'message' AS match_target
  UNION ALL SELECT 'E36_DEPLOY_FAILED', 'Unknown column', 'contains', 'message'
  UNION ALL SELECT 'E36_DEPLOY_FAILED', 'returned failed:128', 'contains', 'message'
  UNION ALL SELECT 'E37_WORKER_EXHAUSTED', 'maximum attempts', 'contains', 'message'
  UNION ALL SELECT 'E37_WORKER_EXHAUSTED', 'Esgotado número máximo de tentativas', 'contains', 'message'
  UNION ALL SELECT 'E38_QUEUE_DLQ', 'invalid-message', 'contains', 'message'
  UNION ALL SELECT 'E38_QUEUE_DLQ', 'max-attempts-exceeded', 'contains', 'message'
  UNION ALL SELECT 'E38_QUEUE_DLQ', 'unexpected-state', 'contains', 'message'
  UNION ALL SELECT 'E39_BASELINE_RED', 'baseline', 'contains', 'message'
  UNION ALL SELECT 'E40_PROMOTION_CONFLICT', 'promotion conflict', 'contains', 'message'
  UNION ALL SELECT 'E41_ANALYSIS_FAILED', 'ANALYSIS_FAILED', 'contains', 'code'
) p ON p.event_code = e.code
WHERE NOT EXISTS (
  SELECT 1 FROM motor_patterns existing
  WHERE existing.event_id = e.id AND existing.pattern = p.pattern
    AND existing.match_type = p.match_type AND existing.match_target = p.match_target
);

-- Toda cadeia de erro recebe uma reação terminal A03. As reações existentes
-- permanecem intactas; somente a ausência da ocorrência terminal é preenchida.
INSERT INTO motor_reactions (event_id, occurrence, action_id, condition_json, version, active)
SELECT e.id, 2, a.id, NULL, 1, 1
FROM motor_events e
JOIN motor_actions a ON a.code = 'A03_BLOCK' AND a.active = 1
WHERE e.code IN (
  'E02_MODEL_UNAVAILABLE', 'E03_MODEL_TIMEOUT', 'E05_RATE_LIMIT',
  'E06_CONSOLE_SYSTEMIC', 'E09_GATE_FAILED'
)
AND NOT EXISTS (
  SELECT 1 FROM motor_reactions r WHERE r.event_id = e.id AND r.occurrence = 2
);

-- Regras novas: primeira ocorrência preserva a intenção existente/reversível;
-- a segunda ocorrência sempre termina em bloqueio para Atenção.
INSERT INTO motor_reactions (event_id, occurrence, action_id, condition_json, version, active)
SELECT e.id, r.occurrence, a.id, NULL, 1, 1
FROM (
  SELECT 'E36_DEPLOY_FAILED' AS event_code, 1 AS occurrence, 'A06_RETRY' AS action_code
  UNION ALL SELECT 'E36_DEPLOY_FAILED', 2, 'A03_BLOCK'
  UNION ALL SELECT 'E37_WORKER_EXHAUSTED', 1, 'A06_RETRY'
  UNION ALL SELECT 'E37_WORKER_EXHAUSTED', 2, 'A03_BLOCK'
  UNION ALL SELECT 'E38_QUEUE_DLQ', 1, 'A06_RETRY'
  UNION ALL SELECT 'E38_QUEUE_DLQ', 2, 'A03_BLOCK'
  UNION ALL SELECT 'E39_BASELINE_RED', 1, 'A18_RECOVER_WORKSPACE'
  UNION ALL SELECT 'E39_BASELINE_RED', 2, 'A03_BLOCK'
  UNION ALL SELECT 'E40_PROMOTION_CONFLICT', 1, 'A14_PROMOTE'
  UNION ALL SELECT 'E40_PROMOTION_CONFLICT', 2, 'A03_BLOCK'
  UNION ALL SELECT 'E41_ANALYSIS_FAILED', 1, 'A06_RETRY'
  UNION ALL SELECT 'E41_ANALYSIS_FAILED', 2, 'A03_BLOCK'
) r
JOIN motor_events e ON e.code = r.event_code AND e.active = 1
JOIN motor_actions a ON a.code = r.action_code AND a.active = 1
WHERE NOT EXISTS (
  SELECT 1 FROM motor_reactions existing
  WHERE existing.event_id = e.id AND existing.occurrence = r.occurrence
);
