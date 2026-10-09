-- Migration 0069: Adiciona suporte a condições estruturadas em motor_reactions
-- Permite regras do tipo "se error_class = environment_failure E attempt >= 2 então ação Z"
-- Sem condition_json → comportamento atual (só ocorrência)
--
-- Idempotente para instalações que já receberam as colunas fora do journal.

SET @governance_conditions_db_name = DATABASE();
--> statement-breakpoint

-- Adiciona coluna condition_json (nullable) para condições estruturadas
SET @condition_json_column_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = @governance_conditions_db_name
    AND table_name = 'motor_reactions'
    AND column_name = 'condition_json'
);
--> statement-breakpoint
SET @condition_json_column_sql = IF(
  @condition_json_column_exists = 0,
  'ALTER TABLE `motor_reactions` ADD COLUMN `condition_json` JSON NULL COMMENT ''Condição estruturada avaliada pelo RuleEvaluator (JSON puro, sem eval). Ex: {"all": [{"field": "errorClass", "op": "eq", "value": "environment_failure"}, {"field": "attempt", "op": "gte", "value": 2}]}''',
  'SELECT 1 AS condition_json_already_exists'
);
--> statement-breakpoint
PREPARE condition_json_column_stmt FROM @condition_json_column_sql;
--> statement-breakpoint
EXECUTE condition_json_column_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE condition_json_column_stmt;
--> statement-breakpoint

-- Adiciona coluna version para versionamento de regras (rollback sem DELETE físico)
SET @version_column_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = @governance_conditions_db_name
    AND table_name = 'motor_reactions'
    AND column_name = 'version'
);
--> statement-breakpoint
SET @version_column_sql = IF(
  @version_column_exists = 0,
  'ALTER TABLE `motor_reactions` ADD COLUMN `version` INT NOT NULL DEFAULT 1 COMMENT ''Versão da regra para histórico e rollback''',
  'SELECT 1 AS version_already_exists'
);
--> statement-breakpoint
PREPARE version_column_stmt FROM @version_column_sql;
--> statement-breakpoint
EXECUTE version_column_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE version_column_stmt;
--> statement-breakpoint

-- Cria índice para buscar reações por evento e condição
SET @event_condition_index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = @governance_conditions_db_name
    AND table_name = 'motor_reactions'
    AND index_name = 'idx_motor_reactions_event_condition'
);
--> statement-breakpoint
SET @event_condition_index_sql = IF(
  @event_condition_index_exists = 0,
  'CREATE INDEX `idx_motor_reactions_event_condition` ON `motor_reactions` (`event_id`, `active`)',
  'SELECT 1 AS idx_motor_reactions_event_condition_already_exists'
);
--> statement-breakpoint
PREPARE event_condition_index_stmt FROM @event_condition_index_sql;
--> statement-breakpoint
EXECUTE event_condition_index_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE event_condition_index_stmt;
--> statement-breakpoint

-- Comentário na tabela
ALTER TABLE motor_reactions
COMMENT = 'Cadeia progressiva de reações por evento. condition_json permite condições além da contagem de ocorrência. version permite rollback sem DELETE físico.';
