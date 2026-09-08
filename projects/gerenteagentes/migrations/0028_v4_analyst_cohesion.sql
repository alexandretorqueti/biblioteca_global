ALTER TABLE `subtarefas` ADD COLUMN `depends_on_subtask_ids` json NULL;
--> statement-breakpoint
UPDATE `subtarefas`
SET `depends_on_subtask_ids` = CASE
  WHEN `depends_on_subtask_id` IS NULL THEN JSON_ARRAY()
  ELSE JSON_ARRAY(`depends_on_subtask_id`)
END
WHERE `depends_on_subtask_ids` IS NULL;
--> statement-breakpoint
INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT c.id, 4,
JSON_OBJECT('oneOf', JSON_ARRAY(
 JSON_OBJECT('type','object','required',JSON_ARRAY('subtarefas','requirements','coverage','estrategia'),
  'properties',JSON_OBJECT(
   'estrategia',JSON_OBJECT('type','object','required',JSON_ARRAY('invariantes','artefatos_compartilhados','ordem_de_execucao')),
   'subtarefas',JSON_OBJECT('type','array','minItems',1), 'requirements',JSON_OBJECT('type','array','minItems',1), 'coverage',JSON_OBJECT('type','array','minItems',1))),
 JSON_OBJECT('type','object','required',JSON_ARRAY('kind','resumo','perguntas')))),
JSON_OBJECT('estrategia',JSON_OBJECT('invariantes',JSON_ARRAY('Dados existentes não podem ser descartados'),'artefatos_compartilhados',JSON_ARRAY('Contrato de preflight'),'ordem_de_execucao',JSON_ARRAY(1,2)), 'subtarefas',JSON_ARRAY(), 'requirements',JSON_ARRAY(), 'coverage',JSON_ARRAY()),
'Responda somente com JSON. Além de requirements e coverage, todo plano exige estrategia: invariantes, artefatos_compartilhados e ordem_de_execucao. depends_on pode conter várias etapas, sempre anteriores. Planeje primeiro contratos, dados e verificadores; depois orquestração e interface; por último validação integrada.',
'V4: coesão arquitetural e dependências múltiplas','sistema'
FROM prompts_contratos c WHERE c.chave='analista.plano_ou_perguntas';
--> statement-breakpoint
UPDATE `prompts_contratos` c JOIN `prompts_contratos_versoes` v ON v.contrato_id=c.id AND v.versao=4 SET c.versao_ativa_id=v.id WHERE c.chave='analista.plano_ou_perguntas';
--> statement-breakpoint
INSERT INTO `prompts_versoes` (`prompt_id`,`versao`,`texto`,`contrato_versao_id`,`motivo`,`autor`,`validacao`)
SELECT p.id,4,CONCAT('Você é o analista responsável por transformar a tarefa **TITULOTAREFA** em um plano completo, coeso, executável e verificável. Tipo: **TIPOTAREFA**. Leia integralmente a descrição: **DESCRICAOTAREFA**. Preserve todos os requisitos, etapas numeradas, sequência e definição de pronto. Antes de dividir o trabalho, identifique invariantes, artefatos compartilhados e o grafo de dependências. Planeje de baixo para cima: primeiro contratos, dados, persistência e verificadores; depois orquestração e interface; por último validação integrada. Nenhuma subtarefa pode depender de artefato criado depois. Use a quantidade necessária de subtarefas, sem unir responsabilidades independentes. Peça esclarecimento somente se a resposta puder mudar escopo, arquitetura ou critério de aceite.\n\n**CONTRATOSAIDA**'), c.versao_ativa_id,'V4: planejamento coeso','sistema',JSON_OBJECT('ok',true)
FROM prompts_agentes p JOIN prompts_contratos c ON c.chave='analista.plano_ou_perguntas' WHERE p.chave='analista.primeira_rodada_tarefa';
--> statement-breakpoint
UPDATE `prompts_agentes` p JOIN `prompts_versoes` v ON v.prompt_id=p.id AND v.versao=4 SET p.versao_ativa_id=v.id,p.status='active' WHERE p.chave='analista.primeira_rodada_tarefa';
--> statement-breakpoint
INSERT INTO `prompts_versoes` (`prompt_id`,`versao`,`texto`,`contrato_versao_id`,`motivo`,`autor`,`validacao`)
SELECT p.id,4,CONCAT('Reanalise **TITULOTAREFA** usando a descrição integral: **DESCRICAOTAREFA**. Histórico respondido: **HISTORICOCLARIFICACAO**. Preserve requisitos e decisões já respondidas. Antes do plano, reconstrua invariantes, artefatos compartilhados e o grafo de dependências. Ordene contratos, dados e verificadores antes de orquestração/interface e valide tudo ao final. Só pergunte se a resposta puder mudar escopo, arquitetura ou critério de aceite.\n\n**CONTRATOSAIDA**'), c.versao_ativa_id,'V4: planejamento coeso','sistema',JSON_OBJECT('ok',true)
FROM prompts_agentes p JOIN prompts_contratos c ON c.chave='analista.plano_ou_perguntas' WHERE p.chave='analista.retomada_apos_clarificacao';
--> statement-breakpoint
UPDATE `prompts_agentes` p JOIN `prompts_versoes` v ON v.prompt_id=p.id AND v.versao=4 SET p.versao_ativa_id=v.id,p.status='active' WHERE p.chave='analista.retomada_apos_clarificacao';
