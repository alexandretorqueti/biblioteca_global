INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT c.id, COALESCE(MAX(v.versao),0)+1, active.schema_json, active.exemplo_json,
  'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect|database_operation","summary":"...","reason":"..."}. Se qualquer alteração, consulta operacional ou verificação de banco for necessária, NUNCA abra conexão MySQL/TCP, use host.docker.internal, procure/peça credenciais ou execute comandos de banco. Salve um .sql UTF-8 dentro do workspace e responda {"status":"database_operation","summary":"...","script_path":"caminho/relativo.sql"}. O Motor executará somente esse arquivo no banco resolvido para a tarefa. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.',
  'Proibir acesso direto do DEV ao banco','sistema'
FROM prompts_contratos c
JOIN prompts_contratos_versoes active ON active.id=c.versao_ativa_id
LEFT JOIN prompts_contratos_versoes v ON v.contrato_id=c.id
WHERE c.chave='dev.resultado_execucao'
GROUP BY c.id, active.schema_json, active.exemplo_json;
--> statement-breakpoint
UPDATE prompts_contratos c JOIN (SELECT contrato_id, MAX(id) id FROM prompts_contratos_versoes GROUP BY contrato_id) latest ON latest.contrato_id=c.id SET c.versao_ativa_id=latest.id WHERE c.chave='dev.resultado_execucao';
--> statement-breakpoint
INSERT INTO prompts_versoes (`prompt_id`,`versao`,`texto`,`contrato_versao_id`,`motivo`,`autor`,`validacao`)
SELECT p.id, COALESCE(MAX(old.versao),0)+1, current.texto, c.versao_ativa_id, 'Vincular guarda de acesso direto ao banco','sistema',JSON_OBJECT('ok',true)
FROM prompts_agentes p
JOIN prompts_versoes current ON current.id=p.versao_ativa_id
JOIN prompts_contratos c ON c.chave='dev.resultado_execucao'
LEFT JOIN prompts_versoes old ON old.prompt_id=p.id
WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate')
GROUP BY p.id,current.texto,c.versao_ativa_id;
--> statement-breakpoint
UPDATE prompts_agentes p JOIN (SELECT prompt_id, MAX(id) id FROM prompts_versoes GROUP BY prompt_id) latest ON latest.prompt_id=p.id JOIN prompts_versoes v ON v.id=latest.id SET p.versao_ativa_id=v.id,p.conteudo=v.texto WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate');
