-- O DEV devolve o caminho de um .sql no worktree; o Motor, e não o agente,
-- executa o arquivo no banco resolvido para a tarefa.
INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_OBJECT('type','object','required',JSON_ARRAY('status','summary'),'properties',JSON_OBJECT('status',JSON_OBJECT('enum',JSON_ARRAY('done','need_help','blocked_environment','premise_incorrect','database_operation')),'summary',JSON_OBJECT('type','string'),'reason',JSON_OBJECT('type','string'),'script_path',JSON_OBJECT('type','string'))),
  JSON_OBJECT('status','done','summary','Alteração implementada e verificada.'),
  'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect|database_operation","summary":"...","reason":"..."}. Se uma alteração no banco do projeto for necessária, não tente obter credenciais nem executá-la: salve um .sql UTF-8 dentro do workspace e responda {"status":"database_operation","summary":"...","script_path":"caminho/relativo.sql"}. O Motor executará apenas esse arquivo no banco resolvido para a tarefa. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.',
  'Permitir operação SQL controlada pelo Motor','sistema'
FROM `prompts_contratos` c LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id=c.id
WHERE c.chave='dev.resultado_execucao'
GROUP BY c.id;
--> statement-breakpoint

UPDATE `prompts_contratos` c
JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest ON latest.contrato_id=c.id
SET c.versao_ativa_id=latest.version_id
WHERE c.chave='dev.resultado_execucao';
--> statement-breakpoint

INSERT INTO `prompts_versoes` (`prompt_id`,`versao`,`texto`,`contrato_versao_id`,`motivo`,`autor`,`validacao`)
SELECT p.id, COALESCE(MAX(v.versao),0)+1,
  CASE p.chave
    WHEN 'dev.primeira_rodada_tarefa' THEN 'Você é o desenvolvedor. Execute a subtarefa **NUMSUBTAREFA** — **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Descrição: **DESCRICAOTAREFA**. Tipo: **TIPOTAREFA**. Escopo: **ESCOPO**. Critérios: **CRITERIOSACEITE**. Workspace: **WORKSPACE**. Não faça commit. Para qualquer alteração no banco do projeto, escreva um único arquivo .sql UTF-8 dentro deste workspace; não procure nem peça credenciais e não o execute. Responda com status database_operation e script_path relativo para o Motor executar o arquivo no banco da tarefa. Responda em JSON.\n\n**CONTRATOSAIDA**'
    ELSE 'Retome a subtarefa **TITULOSUBTAREFA** da tarefa **TITULOTAREFA**. Workspace: **WORKSPACE**. O gate anterior falhou: **ERROGATEANTERIOR**. Corrija a causa raiz, preserve o que já funciona, não faça commit. Se precisar alterar o banco do projeto, salve um .sql UTF-8 no workspace e responda database_operation com script_path relativo; não procure credenciais nem execute o script.\n\n**CONTRATOSAIDA**'
  END,
  c.versao_ativa_id,'Permitir operação SQL controlada pelo Motor','sistema',JSON_OBJECT('ok',true)
FROM `prompts_agentes` p
LEFT JOIN `prompts_versoes` v ON v.prompt_id=p.id
JOIN `prompts_contratos` c ON c.chave='dev.resultado_execucao'
WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate')
GROUP BY p.id, p.chave, c.versao_ativa_id;
--> statement-breakpoint

UPDATE `prompts_agentes` p
JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest ON latest.prompt_id=p.id
JOIN `prompts_versoes` v ON v.id=latest.version_id
SET p.versao_ativa_id=v.id, p.conteudo=v.texto, p.status='active'
WHERE p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate');
