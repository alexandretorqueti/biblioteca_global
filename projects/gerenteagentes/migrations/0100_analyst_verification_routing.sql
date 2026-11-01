-- Contrato v13 do analista: campo OPCIONAL `routing` no veredito verification
-- (task-p2-1047, caso real task-p6-1029: "o problema não é do Admin; é da
-- Biblioteca Global — packages/ui"). O roteamento cross-project estruturado
-- permite ao Motor notificar o usuário e propor/criar a tarefa no projeto de
-- destino em vez de enterrar a recomendação nas mensagens da sessão.
-- Compatibilidade retroativa: `routing` é opcional; respostas v12 (sem
-- routing) continuam válidas. Os demais kinds (perguntas/plano) não mudam.
INSERT INTO `prompts_contratos_versoes`
  (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_SET(active.schema_json,
    '$.oneOf[0].properties.routing', JSON_OBJECT(
      'type','object','additionalProperties',false,'required',JSON_ARRAY('target_project_slug'),
      'properties',JSON_OBJECT(
        'target_project_slug',JSON_OBJECT('type','string','minLength',1),
        'recommended_title',JSON_OBJECT('type','string'),
        'diagnosis',JSON_OBJECT('type','string')))),
  JSON_SET(active.exemplo_json, '$.routing', JSON_OBJECT(
    'target_project_slug','biblioteca-global',
    'recommended_title','Corrigir renderizacao do cartao em packages/ui',
    'diagnosis','O problema nao e do Admin; e da Biblioteca Global — packages/ui.')),
  CONCAT(active.instrucoes,
    ' ROTEAMENTO CROSS-PROJECT (campo opcional "routing" no veredito verification): SEMPRE que voce concluir que o trabalho pertence a OUTRO projeto e recomendar criar uma tarefa la, preencha routing com {"target_project_slug":"<slug do projeto de destino>","recommended_title":"<titulo sugerido>","diagnosis":"<diagnostico resumido>"}. Exemplo (caso real task-p6-1029): analise de tarefa do Admin concluiu que o defeito estava em packages/ui da Biblioteca Global — routing {"target_project_slug":"biblioteca-global","recommended_title":"Corrigir renderizacao do cartao em packages/ui","diagnosis":"O problema nao e do Admin; e da Biblioteca Global — packages/ui."}. routing.target_project_slug e obrigatorio quando routing esta presente; se o problema E do projeto atual, nao inclua routing.'),
  'Roteamento cross-project opcional no veredito verification (contrato v13, task-p2-1047)', 'sistema'
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
-- Nova versão dos prompts do analista (primeira rodada e retomada) instruindo
-- explicitamente o uso de routing para recomendação cross-project, com exemplo.
INSERT INTO `prompts_versoes`
  (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(previous.versao), 0) + 1,
  CONCAT(active.texto,
    '\n\n### Roteamento cross-project (veredito verification)\nQuando a analise concluir que o trabalho NAO pertence a este projeto e recomendar criar tarefa em outro projeto, preencha SEMPRE o campo opcional "routing" no veredito verification: {"kind":"verification","verdict":"...","summary":"...","evidence":["..."],"routing":{"target_project_slug":"<slug do projeto de destino>","recommended_title":"<titulo sugerido>","diagnosis":"<diagnostico resumido>"}}. Exemplo (caso real task-p6-1029): "o problema nao e do Admin; e da Biblioteca Global — packages/ui" → routing {"target_project_slug":"biblioteca-global","recommended_title":"Corrigir renderizacao do cartao em packages/ui","diagnosis":"O defeito esta no componente da Biblioteca Global (packages/ui), nao no Admin."}. Se o problema e do projeto atual, NAO inclua routing. O campo e opcional: respostas sem routing continuam validas.'),
  contract.versao_ativa_id, 'Instruir routing cross-project no veredito verification (task-p2-1047)', 'sistema', JSON_OBJECT('ok', true)
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
