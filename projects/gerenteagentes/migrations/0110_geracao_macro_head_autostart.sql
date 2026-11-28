-- Cabeça de cadeia com auto_start=true (task-p2-1150, incidente vitrine-ia
-- 27/11/2026, cadeia 1137-1147): plano macro aprovado deve iniciar sem
-- intervenção manual. A cabeça (menor seq, depende_de vazio) com auto_start=0
-- fica órfã de gatilho — o dispatch exige auto_start=1 e a retomada de
-- dependentes (regra da tarefa 1121) só age na CONCLUSÃO da dependência.
-- Esta migração versiona o prompt de geração macro e seu contrato de saída
-- instruindo explicitamente: PRIMEIRA tarefa → auto_start=true; demais →
-- auto_start=false (ordem governada por dependências + retomada automática).
-- Padrão canônico 0100: INSERT nova versão (versao = MAX+1) + troca de
-- versao_ativa_id. Guardas NOT EXISTS por motivo tornam a reexecução um no-op
-- (sem duplicar versões).
INSERT INTO `prompts_contratos_versoes`
  (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  active.schema_json,
  JSON_SET(active.exemplo_json, '$.tarefas[0].auto_start', CAST(TRUE AS JSON)),
  REPLACE(
    REPLACE(active.instrucoes,
      '"depende_de":[],"auto_start":false,"risco":"baixo|medio|alto"}]',
      '"depende_de":[],"auto_start":true|false,"risco":"baixo|medio|alto"}]'),
    'depende_de expressa ordem topológica linear (apenas seq anteriores);',
    'depende_de expressa ordem topológica linear (apenas seq anteriores); a primeira tarefa da cadeia (menor seq, depende_de vazio) DEVE ter auto_start=true — plano aprovado inicia sem intervenção manual; as demais usam auto_start=false (a ordem de despacho é governada por dependências + retomada automática dos dependentes na conclusão da dependência);'),
  'Cabeca da cadeia macro com auto_start=true no contrato de saida da geracao (task-p2-1150)', 'sistema'
FROM `prompts_contratos` c
JOIN `prompts_contratos_versoes` active ON active.id = c.versao_ativa_id
LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'geracao.plano_ou_perguntas'
  AND NOT EXISTS (SELECT 1 FROM `prompts_contratos_versoes` dup WHERE dup.contrato_id = c.id AND dup.motivo = 'Cabeca da cadeia macro com auto_start=true no contrato de saida da geracao (task-p2-1150)')
GROUP BY c.id, active.schema_json, active.exemplo_json, active.instrucoes;
--> statement-breakpoint
UPDATE `prompts_contratos` c
JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest
  ON latest.contrato_id = c.id
SET c.versao_ativa_id = latest.version_id
WHERE c.chave = 'geracao.plano_ou_perguntas';
--> statement-breakpoint
-- Nova versão do prompt geracao.plano_macro_projeto: o bloco == REGRAS == troca
-- a regra antiga ("default false") pela regra da cabeça da cadeia. O texto
-- substituído é byte a byte o vigente no catálogo (fonte do seed/bootstrap).
INSERT INTO `prompts_versoes`
  (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(previous.versao), 0) + 1,
  REPLACE(active.texto,
    '- auto_start=true somente quando o plano justificar execução automática imediata; o default é false (sequência controlada por dependência).',
    '- auto_start: a PRIMEIRA tarefa da cadeia (menor seq, depende_de vazio) DEVE ter auto_start=true — plano aprovado inicia sem intervenção manual; as demais tarefas usam auto_start=false (a ordem de despacho é governada por dependências + retomada automática dos dependentes na conclusão da dependência).'),
  contract.versao_ativa_id, 'Cabeca da cadeia macro com auto_start=true no prompt de geracao (task-p2-1150)', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
JOIN `prompts_versoes` active ON active.id = p.versao_ativa_id
JOIN `prompts_contratos` contract ON contract.chave = 'geracao.plano_ou_perguntas'
LEFT JOIN `prompts_versoes` previous ON previous.prompt_id = p.id
WHERE p.chave = 'geracao.plano_macro_projeto'
  AND NOT EXISTS (SELECT 1 FROM `prompts_versoes` dup WHERE dup.prompt_id = p.id AND dup.motivo = 'Cabeca da cadeia macro com auto_start=true no prompt de geracao (task-p2-1150)')
GROUP BY p.id, active.texto, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p
JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest
  ON latest.prompt_id = p.id
SET p.versao_ativa_id = latest.version_id
WHERE p.chave = 'geracao.plano_macro_projeto';
