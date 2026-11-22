-- Frente C do rollout de governança do Motor v3.
-- Seed aditivo e inerte: nenhuma flag governed_failure_* é criada ou alterada.
-- As reações ficam disponíveis para simular/dry-run; o rollout continua sob as
-- flags já existentes e não é ligado por esta migration.
SET NAMES utf8mb4;
--> statement-breakpoint

-- Eventos novos. Os códigos são inseridos somente se ainda não existirem, para
-- preservar qualquer decisão manual já registrada no catálogo.
INSERT INTO `motor_events` (`code`, `name`, `category`, `scope`, `priority`, `active`)
SELECT 'E58_DEPLOY_MEMBER_CONFLICT', 'Conflito de migration entre membros do deploy', 'erro', 'tarefa', 24, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_events` WHERE `code` = 'E58_DEPLOY_MEMBER_CONFLICT');
--> statement-breakpoint
INSERT INTO `motor_events` (`code`, `name`, `category`, `scope`, `priority`, `active`)
SELECT 'E59_DEPLOY_FAILED_DUPLICATE', 'Falha de deploy duplicada ou em cascata', 'erro', 'tarefa', 25, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_events` WHERE `code` = 'E59_DEPLOY_FAILED_DUPLICATE');
--> statement-breakpoint
INSERT INTO `motor_events` (`code`, `name`, `category`, `scope`, `priority`, `active`)
SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', 'Indisponibilidade transitória do worker de deploy', 'infra', 'projeto', 61, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_events` WHERE `code` = 'E60_DEPLOY_WORKER_INFRA_FAILURE');
--> statement-breakpoint
INSERT INTO `motor_events` (`code`, `name`, `category`, `scope`, `priority`, `active`)
SELECT 'E61_ANALYSIS_TIMEOUT', 'Timeout da análise', 'erro', 'subtarefa', 29, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_events` WHERE `code` = 'E61_ANALYSIS_TIMEOUT');
--> statement-breakpoint

-- A primitiva é implementada no domínio git e já é consumida pelo fluxo de
-- composição do DeployConsumer. A ação não ativa o fluxo por si só.
INSERT INTO `motor_primitives` (`code`, `name`, `domain`, `description`)
SELECT 'renumber_migration', 'Renumera migration e regenera o journal', 'git',
       'Resolve colisão de índice de migration entre membros do batch, renomeando o arquivo e atualizando meta/_journal.json.'
WHERE NOT EXISTS (SELECT 1 FROM `motor_primitives` WHERE `code` = 'renumber_migration');
--> statement-breakpoint

-- Ações compostas. Todas as primitivas referenciadas são primitivas registradas;
-- a ação de retry mantém a execução governada inerte até o wiring do rollout.
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A_RENUMBER_MIGRATION_RETRY_COMPOSE',
       'Renumera migration e refaz composição do deploy',
       JSON_ARRAY(
         JSON_OBJECT('primitive', 'renumber_migration'),
         JSON_OBJECT('primitive', 'set_flag', 'params', JSON_OBJECT('flag', 'retry')),
         JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'warn', 'message', 'Migration renumerada após conflito no _journal.json; composição será refeita'))
       ),
       'continue', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A_RENUMBER_MIGRATION_RETRY_COMPOSE');
--> statement-breakpoint
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A_DEDUP_DEPLOY_FAILURE',
       'Dispensar bloqueios duplicados de deploy',
       JSON_ARRAY(
         JSON_OBJECT('primitive', 'set_flag', 'params', JSON_OBJECT('flag', 'deduplicate_deploy_failure', 'keep_one_blocker', true)),
         JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'info', 'message', 'Bloqueio deploy_failed duplicado dispensado; causa raiz preservada'))
       ),
       'continue', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A_DEDUP_DEPLOY_FAILURE');
--> statement-breakpoint
INSERT INTO `motor_actions`
  (`code`, `name`, `primitives_json`, `on_partial_failure`, `is_terminal`, `active`)
SELECT 'A_CLASSIFY_INFRA_RETRY_BACKOFF',
       'Classificar infraestrutura e refazer deploy com backoff',
       JSON_ARRAY(
         JSON_OBJECT('primitive', 'set_flag', 'params', JSON_OBJECT('flag', 'error_class', 'value', 'infrastructure')),
         JSON_OBJECT('primitive', 'set_flag', 'params', JSON_OBJECT('flag', 'retry', 'backoff', 'exponential')),
         JSON_OBJECT('primitive', 'log', 'params', JSON_OBJECT('level', 'warn', 'message', 'Worker indisponível; retry de deploy com backoff sem bloquear a tarefa'))
       ),
       'continue', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM `motor_actions` WHERE `code` = 'A_CLASSIFY_INFRA_RETRY_BACKOFF');
--> statement-breakpoint

-- Padrões concretos, sempre aditivos. O padrão do journal é específico para não
-- capturar conflitos Git de arquivos que não sejam migrations.
INSERT INTO `motor_patterns` (`event_id`, `pattern`, `match_type`, `match_target`, `active`)
SELECT e.id, p.pattern, p.match_type, p.match_target, 1
FROM `motor_events` e
INNER JOIN (
  SELECT 'E58_DEPLOY_MEMBER_CONFLICT' AS event_code, 'database/migrations/_journal.json' AS pattern, 'contains' AS match_type, 'message' AS match_target
  UNION ALL SELECT 'E59_DEPLOY_FAILED_DUPLICATE', 'deploy_failed', 'contains', 'message'
  UNION ALL SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', '503', 'contains', 'message'
  UNION ALL SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', 'Service Unavailable', 'contains', 'message'
  UNION ALL SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', 'provider error', 'contains', 'message'
  UNION ALL SELECT 'E61_ANALYSIS_TIMEOUT', 'analysis_timeout', 'exact', 'code'
) p ON p.event_code = e.code
WHERE NOT EXISTS (
  SELECT 1 FROM `motor_patterns` existing
  WHERE existing.event_id = e.id
    AND existing.pattern = p.pattern
    AND existing.match_type = p.match_type
    AND existing.match_target = p.match_target
);
--> statement-breakpoint

-- Reações do conflito de journal: uma tentativa automática; persistindo,
-- bloqueio terminal e alerta humano via A03_BLOCK.
INSERT INTO `motor_reactions` (`event_id`, `occurrence`, `action_id`, `params_json`, `active`)
SELECT e.id, r.occurrence, a.id, r.params_json, 1
FROM (
  SELECT 'E58_DEPLOY_MEMBER_CONFLICT' AS event_code, 1 AS occurrence, 'A_RENUMBER_MIGRATION_RETRY_COMPOSE' AS action_code,
         JSON_OBJECT('policy', 'renumber_then_retry_compose') AS params_json
  UNION ALL SELECT 'E58_DEPLOY_MEMBER_CONFLICT', 2, 'A03_BLOCK', JSON_OBJECT('policy', 'human_alert_and_block')
  UNION ALL SELECT 'E59_DEPLOY_FAILED_DUPLICATE', 1, 'A_DEDUP_DEPLOY_FAILURE', JSON_OBJECT('policy', 'keep_one_root_blocker')
  UNION ALL SELECT 'E59_DEPLOY_FAILED_DUPLICATE', 2, 'A03_BLOCK', JSON_OBJECT('policy', 'human_alert_and_block')
  UNION ALL SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', 1, 'A_CLASSIFY_INFRA_RETRY_BACKOFF', JSON_OBJECT('policy', 'transient_infrastructure_retry')
  UNION ALL SELECT 'E60_DEPLOY_WORKER_INFRA_FAILURE', 2, 'A03_BLOCK', JSON_OBJECT('policy', 'human_alert_and_block')
  UNION ALL SELECT 'E61_ANALYSIS_TIMEOUT', 1, 'A02_ESCALATE', JSON_OBJECT('policy', 'legacy_next_model')
) r
INNER JOIN `motor_events` e ON e.code = r.event_code
INNER JOIN `motor_actions` a ON a.code = r.action_code
WHERE NOT EXISTS (
  SELECT 1 FROM `motor_reactions` existing
  WHERE existing.event_id = e.id AND existing.occurrence = r.occurrence
);
--> statement-breakpoint

-- E49/E50/E53 já possuem padrões canônicos (migration 0075), mas eram órfãos.
-- Preenche apenas as reações ausentes: retry único, depois alerta/bloqueio.
INSERT INTO `motor_reactions` (`event_id`, `occurrence`, `action_id`, `params_json`, `active`)
SELECT e.id, r.occurrence, a.id, JSON_OBJECT('policy', r.policy), 1
FROM (
  SELECT 'E49_DEPLOY_INVARIANT_FAILURE' AS event_code, 1 AS occurrence, 'A06_RETRY' AS action_code, 'retry_once' AS policy
  UNION ALL SELECT 'E49_DEPLOY_INVARIANT_FAILURE', 2, 'A03_BLOCK', 'human_alert_and_block'
  UNION ALL SELECT 'E50_DEPLOY_REMOTE_FAILURE', 1, 'A06_RETRY', 'retry_once'
  UNION ALL SELECT 'E50_DEPLOY_REMOTE_FAILURE', 2, 'A03_BLOCK', 'human_alert_and_block'
  UNION ALL SELECT 'E53_DEPLOY_LOCK_BUSY', 1, 'A06_RETRY', 'defer_once_legacy_parity'
  UNION ALL SELECT 'E53_DEPLOY_LOCK_BUSY', 2, 'A03_BLOCK', 'human_alert_and_block'
) r
INNER JOIN `motor_events` e ON e.code = r.event_code
INNER JOIN `motor_actions` a ON a.code = r.action_code
WHERE NOT EXISTS (
  SELECT 1 FROM `motor_reactions` existing
  WHERE existing.event_id = e.id AND existing.occurrence = r.occurrence
);
