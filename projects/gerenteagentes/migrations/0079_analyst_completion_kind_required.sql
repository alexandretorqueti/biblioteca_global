-- Exige classificação por subtarefa e publica novas versões auditáveis dos prompts ativos.
INSERT INTO `prompts_contratos_versoes`
  (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_SET(active.schema_json,
    '$.oneOf[0].properties.subtarefas.items.required',
    JSON_ARRAY('seq', 'titulo', 'scope', 'acceptance_criteria', 'deliverables', 'requirements_covered', 'depends_on', 'completion_kind')),
  JSON_SET(active.exemplo_json,
    '$.subtarefas[0].completion_kind', 'code_change'),
  CONCAT(active.instrucoes,
    ' completion_kind é obrigatório em toda subtarefa e aceita somente code_change, analysis, no_code_change ou external_operation. Use code_change para implementação ou alteração de código; analysis ou no_code_change para validação, checagem ou verificação; external_operation para operação fora do código.'),
  'Exigir completion_kind por subtarefa com classificação operacional', 'sistema'
FROM `prompts_contratos` c
JOIN `prompts_contratos_versoes` active ON active.id = c.versao_ativa_id
LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'analista.plano_ou_perguntas'
GROUP BY c.id, active.schema_json, active.exemplo_json, active.instrucoes;
--> statement-breakpoint
UPDATE `prompts_contratos` c
JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest
  ON latest.contrato_id = c.id
SET c.versao_ativa_id = latest.version_id
WHERE c.chave = 'analista.plano_ou_perguntas';
--> statement-breakpoint
INSERT INTO `prompts_versoes`
  (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(previous.versao), 0) + 1,
  CONCAT(active.texto,
    '\n\n### Classificação obrigatória da subtarefa\nInforme completion_kind em TODA subtarefa: code_change para implementação ou alteração de código; analysis ou no_code_change para validação, checagem ou verificação; external_operation para operações fora do código.'),
  contract.versao_ativa_id, 'Exigir completion_kind em toda subtarefa planejada', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
JOIN `prompts_versoes` active ON active.id = p.versao_ativa_id
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
LEFT JOIN `prompts_versoes` previous ON previous.prompt_id = p.id
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao')
GROUP BY p.id, active.texto, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p
JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest
  ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id
WHERE p.chave IN ('analista.primeira_rodada_tarefa', 'analista.retomada_apos_clarificacao');
