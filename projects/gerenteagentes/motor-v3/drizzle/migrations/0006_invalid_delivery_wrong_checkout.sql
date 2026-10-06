-- Entrega inválida distinta de "nenhuma alteração": o diff existe no checkout
-- principal, enquanto o worktree autorizado permaneceu inalterado.
SET NAMES utf8mb4;

INSERT INTO motor_events (code, name, category, scope, priority, active) VALUES
  ('E42_INVALID_DELIVERY_WRONG_CHECKOUT', 'Entrega inválida: checkout principal alterado', 'erro', 'subtarefa', 425, 1)
ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), scope=VALUES(scope), priority=VALUES(priority), active=1;

INSERT INTO motor_patterns (event_id, pattern, match_type, match_target, active)
SELECT e.id, 'INVALID_DELIVERY_WRONG_CHECKOUT', 'contains', 'code', 1
FROM motor_events e
WHERE e.code='E42_INVALID_DELIVERY_WRONG_CHECKOUT'
  AND NOT EXISTS (
    SELECT 1 FROM motor_patterns p WHERE p.event_id=e.id AND p.pattern='INVALID_DELIVERY_WRONG_CHECKOUT'
      AND p.match_type='contains' AND p.match_target='code'
  );

INSERT INTO motor_reactions (event_id, occurrence, action_id, condition_json, version, active)
SELECT e.id, 1, a.id, NULL, 1, 1
FROM motor_events e JOIN motor_actions a ON a.code='A03_BLOCK' AND a.active=1
WHERE e.code='E42_INVALID_DELIVERY_WRONG_CHECKOUT'
  AND NOT EXISTS (SELECT 1 FROM motor_reactions r WHERE r.event_id=e.id AND r.occurrence=1);
