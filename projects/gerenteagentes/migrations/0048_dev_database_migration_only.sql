-- O Motor não executa SQL devolvido pelo DEV. A alteração deve ser uma
-- migration versionada, revisada e aplicada pelo fluxo de deploy.
INSERT INTO prompts_versoes (prompt_id, versao, texto, contrato_versao_id, motivo, autor, validacao)
SELECT p.id, COALESCE(MAX(v.versao), 0) + 1,
  REPLACE(REPLACE(p.conteudo,
    'Para qualquer operação de banco — alteração, consulta operacional ou verificação — não abra conexão TCP/MySQL, não use host.docker.internal, não procure/peça credenciais e não execute comandos de banco. Escreva um único arquivo .sql UTF-8 dentro deste workspace e responda com status database_operation e script_path relativo para o Motor executar o arquivo no banco da tarefa.',
    'Para tarefas que exigem mudança ou importação de dados, crie a migration correta no diretório de migrations do projeto. Não abra conexão TCP/MySQL, não procure credenciais e não execute SQL. Responda com status database_operation e script_path relativo da migration para revisão e aplicação no fluxo de deploy.'),
    'Para qualquer alteração no banco do projeto, escreva um único arquivo .sql UTF-8 dentro deste workspace; não procure nem peça credenciais e não o execute. Responda com status database_operation e script_path relativo para o Motor executar o arquivo no banco da tarefa.',
    'Para tarefas que exigem mudança ou importação de dados, crie a migration correta no diretório de migrations do projeto. Não abra conexão TCP/MySQL, não procure credenciais e não execute SQL. Responda com status database_operation e script_path relativo da migration para revisão e aplicação no fluxo de deploy.'),
  (SELECT c.versao_ativa_id FROM prompts_contratos c WHERE c.chave = 'dev.resultado_execucao'),
  'DEV cria migration; Motor não executa SQL', 'sistema', JSON_OBJECT('ok', true)
FROM prompts_agentes p LEFT JOIN prompts_versoes v ON v.prompt_id = p.id
WHERE p.chave = 'dev.primeira_rodada_tarefa'
GROUP BY p.id, p.conteudo, p.versao_ativa_id;
--> statement-breakpoint
UPDATE prompts_agentes p JOIN (SELECT prompt_id, MAX(id) id FROM prompts_versoes GROUP BY prompt_id) latest ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.id, p.conteudo = (SELECT texto FROM prompts_versoes WHERE id = latest.id)
WHERE p.chave = 'dev.primeira_rodada_tarefa';
--> statement-breakpoint
INSERT INTO prompts_contratos_versoes (contrato_id, versao, schema_json, exemplo_json, instrucoes, motivo, autor)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1, active.schema_json, active.exemplo_json,
  'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect|database_operation","summary":"...","reason":"..."}. Se a tarefa exigir mudança ou importação de dados, crie uma migration .sql UTF-8 dentro do diretório de migrations do projeto. NUNCA abra conexão MySQL/TCP, procure credenciais ou execute SQL. Responda {"status":"database_operation","summary":"...","script_path":"caminho/relativo da migration"}. A migration será revisada e aplicada no fluxo de deploy. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.',
  'DEV cria migration; Motor não executa SQL', 'sistema'
FROM prompts_contratos c
JOIN prompts_contratos_versoes active ON active.id = c.versao_ativa_id
LEFT JOIN prompts_contratos_versoes v ON v.contrato_id = c.id
WHERE c.chave = 'dev.resultado_execucao'
GROUP BY c.id, active.schema_json, active.exemplo_json;
--> statement-breakpoint
UPDATE prompts_contratos c JOIN (SELECT contrato_id, MAX(id) id FROM prompts_contratos_versoes GROUP BY contrato_id) latest ON latest.contrato_id = c.id
SET c.versao_ativa_id = latest.id
WHERE c.chave = 'dev.resultado_execucao';
