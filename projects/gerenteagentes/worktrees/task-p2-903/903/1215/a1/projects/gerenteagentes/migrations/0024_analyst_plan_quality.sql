ALTER TABLE `tarefas` ADD COLUMN `plan_coverage` json NULL;
--> statement-breakpoint
ALTER TABLE `subtarefas` ADD COLUMN `deliverables` json NULL, ADD COLUMN `requirements_covered` json NULL;
--> statement-breakpoint
INSERT INTO `prompts_contratos_versoes` (`contrato_id`, `versao`, `schema_json`, `exemplo_json`, `instrucoes`, `motivo`, `autor`)
SELECT c.id, COALESCE(MAX(v.versao), 0) + 1,
  JSON_OBJECT('required', JSON_ARRAY('subtarefas', 'requirements', 'coverage')),
  JSON_OBJECT('subtarefas', JSON_ARRAY(), 'requirements', JSON_ARRAY(), 'coverage', JSON_ARRAY()),
  'Um plano exige subtarefas detalhadas com seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered e depends_on; requirements e coverage são obrigatórios.',
  'Contrato de plano detalhado e matriz de cobertura', 'sistema'
FROM `prompts_contratos` c LEFT JOIN `prompts_contratos_versoes` v ON v.contrato_id = c.id
WHERE c.chave = 'analista.plano_ou_perguntas'
GROUP BY c.id;
--> statement-breakpoint
UPDATE `prompts_contratos` c JOIN (SELECT contrato_id, MAX(id) AS version_id FROM `prompts_contratos_versoes` GROUP BY contrato_id) latest ON latest.contrato_id = c.id SET c.versao_ativa_id = latest.version_id WHERE c.chave = 'analista.plano_ou_perguntas';
--> statement-breakpoint
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(v.versao), 0) + 1,
  'Você é o analista responsável por transformar a tarefa **TITULOTAREFA** em um plano completo, executável e verificável. Tipo: **TIPOTAREFA**. Leia integralmente a descrição abaixo, preserve todos os requisitos, etapas numeradas, sequência e definição de pronto. Não minimize artificialmente a quantidade de subtarefas nem una etapas independentes. Cada subtarefa deve ter uma responsabilidade principal, escopo detalhado, entregáveis concretos, critérios objetivos e requisitos cobertos. Identifique todos os requisitos como REQ-* e forneça a matriz de cobertura. Se a descrição estiver truncada, incompleta ou ambígua, não invente um plano: peça esclarecimentos. Descrição integral: **DESCRICAOTAREFA**\n\n**CONTRATOSAIDA**',
  contract.versao_ativa_id, 'Plano detalhado e matriz de cobertura do analista', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
LEFT JOIN `prompts_versoes` v ON v.prompt_id = p.id
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
WHERE p.chave = 'analista.primeira_rodada_tarefa'
GROUP BY p.id, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest ON latest.prompt_id = p.id SET p.versao_ativa_id = latest.version_id WHERE p.chave = 'analista.primeira_rodada_tarefa';
--> statement-breakpoint
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(v.versao), 0) + 1,
  'Reanalise **TITULOTAREFA** usando a descrição integral: **DESCRICAOTAREFA**. Histórico já respondido: **HISTORICOCLARIFICACAO**. Preserve todos os requisitos e etapas, não una responsabilidades independentes, e não repita perguntas respondidas. Quando estiver claro, devolva plano completo com requisitos e matriz de cobertura; caso contrário, faça perguntas objetivas.\n\n**CONTRATOSAIDA**',
  contract.versao_ativa_id, 'Retomada detalhada do plano do analista', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
LEFT JOIN `prompts_versoes` v ON v.prompt_id = p.id
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
WHERE p.chave = 'analista.retomada_apos_clarificacao'
GROUP BY p.id, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest ON latest.prompt_id = p.id SET p.versao_ativa_id = latest.version_id WHERE p.chave = 'analista.retomada_apos_clarificacao';
