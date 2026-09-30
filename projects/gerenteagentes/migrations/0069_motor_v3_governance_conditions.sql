-- Migration 0069: Adiciona suporte a condições estruturadas em motor_reactions
-- Permite regras do tipo "se error_class = environment_failure E attempt >= 2 então ação Z"
-- Sem condition_json → comportamento atual (só ocorrência)

-- Adiciona coluna condition_json (nullable) para condições estruturadas
ALTER TABLE motor_reactions
ADD COLUMN condition_json JSON NULL COMMENT 'Condição estruturada avaliada pelo RuleEvaluator (JSON puro, sem eval). Ex: {"all": [{"field": "errorClass", "op": "eq", "value": "environment_failure"}, {"field": "attempt", "op": "gte", "value": 2}]}';

-- Adiciona coluna version para versionamento de regras (rollback sem DELETE físico)
ALTER TABLE motor_reactions
ADD COLUMN version INT NOT NULL DEFAULT 1 COMMENT 'Versão da regra para histórico e rollback';

-- Cria índice para buscar reações por evento e condição
CREATE INDEX idx_motor_reactions_event_condition ON motor_reactions(event_id, active);

-- Comentário na tabela
ALTER TABLE motor_reactions
COMMENT = 'Cadeia progressiva de reações por evento. condition_json permite condições além da contagem de ocorrência. version permite rollback sem DELETE físico.';
