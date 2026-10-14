-- Tarefas de verificacao clara terminam com parecer do Analista no chat.
-- Ambiguidade continua usando a assinatura de perguntas; planos seguem
-- disponiveis para os demais tipos de tarefa.
INSERT INTO `prompts_contratos_versoes`
  (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_SET(active.schema_json, '$.oneOf', JSON_ARRAY(
    JSON_OBJECT('type','object','additionalProperties',false,'required',JSON_ARRAY('kind','verdict','summary','evidence'),
      'properties',JSON_OBJECT('kind',JSON_OBJECT('enum',JSON_ARRAY('verification','verificacao')),
        'verdict',JSON_OBJECT('type','string','minLength',1), 'summary',JSON_OBJECT('type','string','minLength',1),
        'evidence',JSON_OBJECT('type','array','items',JSON_OBJECT('type','string')))),
    JSON_EXTRACT(active.schema_json, '$.oneOf[0]'), JSON_EXTRACT(active.schema_json, '$.oneOf[1]'))),
  JSON_OBJECT('kind','verification','verdict','Confirmado','summary','Verificacao concluida diretamente pelo Analista.','evidence',JSON_ARRAY('Evidencia consultada')),
  CONCAT(active.instrucoes, ' Para tarefa do tipo verificacao clara, faca a verificacao diretamente e responda com {"kind":"verification","verdict":"...","summary":"...","evidence":["..."]}; nao crie subtarefas, nao acione DEV nem worktree. Se houver ambiguidade, use a assinatura de perguntas e aguarde o chat.'),
  'Permitir verificacao direta pelo Analista sem subtarefa', 'sistema'
FROM `prompts_contratos` c
JOIN `prompts_contratos_versoes` active ON active.id = c.versao_ativa_id
LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'analista.plano_ou_perguntas'
GROUP BY c.id, active.schema_json, active.instrucoes;
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
    '\n\n### Verificacao direta\nPara tarefa com tipo verificacao, quando estiver clara, faca a verificacao diretamente e retorne o parecer estruturado no chat. Nao crie subtarefas, nao acione DEV nem worktree. Se houver duvida, faca perguntas objetivas e aguarde a resposta no chat.'),
  contract.versao_ativa_id, 'Executar verificacao clara diretamente pelo Analista', 'sistema', JSON_OBJECT('ok', true)
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
