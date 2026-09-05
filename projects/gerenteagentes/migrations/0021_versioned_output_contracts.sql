CREATE TABLE `prompts_contratos` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT, `chave` varchar(160) NOT NULL,
  `titulo` varchar(200) NOT NULL, `descricao` text NULL,
  `status` enum('draft','active','inactive') NOT NULL DEFAULT 'draft',
  `versao_ativa_id` bigint unsigned NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `prompts_contratos_chave_unique` (`chave`)
);
--> statement-breakpoint
CREATE TABLE `prompts_contratos_versoes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT, `contrato_id` bigint unsigned NOT NULL,
  `versao` int NOT NULL, `schema_json` json NOT NULL, `exemplo_json` json NOT NULL,
  `instrucoes` text NOT NULL, `motivo` text NULL, `autor` varchar(200) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`), UNIQUE KEY `prompts_contratos_versao_unique` (`contrato_id`,`versao`),
  CONSTRAINT `prompts_contratos_versoes_contrato_fk` FOREIGN KEY (`contrato_id`) REFERENCES `prompts_contratos` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `prompts_contratos` ADD CONSTRAINT `prompts_contratos_versao_ativa_fk` FOREIGN KEY (`versao_ativa_id`) REFERENCES `prompts_contratos_versoes` (`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `prompts_versoes` ADD COLUMN `contrato_versao_id` bigint unsigned NULL, ADD CONSTRAINT `prompts_versoes_contrato_fk` FOREIGN KEY (`contrato_versao_id`) REFERENCES `prompts_contratos_versoes` (`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `prompts_execucoes` ADD COLUMN `contrato_versao_id` bigint unsigned NULL, ADD CONSTRAINT `prompts_execucoes_contrato_fk` FOREIGN KEY (`contrato_versao_id`) REFERENCES `prompts_contratos_versoes` (`id`) ON DELETE SET NULL;
--> statement-breakpoint
INSERT IGNORE INTO `prompts_mascaras` (`nome`,`descricao`,`tipo_valor`,`origem`,`obrigatoria`,`sensivel`,`ativa`) VALUES ('**CONTRATOSAIDA**','Instruções da versão do contrato vinculada ao prompt','texto','Motor: contrato de saída versionado',1,0,1);
--> statement-breakpoint

INSERT IGNORE INTO `prompts_contratos` (`chave`,`titulo`,`descricao`,`status`) VALUES
('analista.plano_ou_perguntas','Plano ou perguntas do analista','Resposta da análise inicial e da retomada','draft'),
('dev.resultado_execucao','Resultado do desenvolvedor','Resultado normal, bloqueio ou refutação','draft'),
('monitor.veredito_gate','Veredito de falha do gate','Classificação estruturada de falha','draft');
--> statement-breakpoint
INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT id,1,JSON_OBJECT('oneOf',JSON_ARRAY(JSON_OBJECT('required',JSON_ARRAY('subtarefas')),JSON_OBJECT('required',JSON_ARRAY('kind','resumo','perguntas')))),JSON_OBJECT('subtarefas',JSON_ARRAY(JSON_OBJECT('seq',1,'titulo','Implementar alteração','scope','Alterar o componente necessário.','acceptance_criteria',JSON_ARRAY('Comportamento validado')))),'Responda somente com JSON. Quando estiver claro, use {"subtarefas":[{"seq":1,"titulo":"...","scope":"...","acceptance_criteria":["..."]}]}. Quando faltar decisão, use {"kind":"perguntas","resumo":"...","perguntas":["..."]}.','Bootstrap canônico','sistema' FROM `prompts_contratos` c WHERE chave='analista.plano_ou_perguntas' AND NOT EXISTS (SELECT 1 FROM `prompts_contratos_versoes` v WHERE v.contrato_id=c.id);
--> statement-breakpoint
INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT id,1,JSON_OBJECT('required',JSON_ARRAY('status','summary')),JSON_OBJECT('status','done','summary','Alteração implementada e verificada.'),'Responda somente com JSON: {"status":"done|need_help|blocked_environment|premise_incorrect","summary":"...","reason":"..."}. Para premise_incorrect, inclua claim, conflict_type, evidence e suggested_revision.','Bootstrap canônico','sistema' FROM `prompts_contratos` c WHERE chave='dev.resultado_execucao' AND NOT EXISTS (SELECT 1 FROM `prompts_contratos_versoes` v WHERE v.contrato_id=c.id);
--> statement-breakpoint
INSERT INTO `prompts_contratos_versoes` (`contrato_id`,`versao`,`schema_json`,`exemplo_json`,`instrucoes`,`motivo`,`autor`)
SELECT id,1,JSON_OBJECT('required',JSON_ARRAY('verdict','analysis')),JSON_OBJECT('verdict','agent_can_solve','analysis','Falha localizada na implementação.'),'Responda somente com JSON: {"verdict":"agent_can_solve|code_files_issue|test_files_issue|motor_issue","analysis":"...","solution":"..."}.','Bootstrap canônico','sistema' FROM `prompts_contratos` c WHERE chave='monitor.veredito_gate' AND NOT EXISTS (SELECT 1 FROM `prompts_contratos_versoes` v WHERE v.contrato_id=c.id);
--> statement-breakpoint
UPDATE `prompts_contratos` c INNER JOIN `prompts_contratos_versoes` v ON v.contrato_id=c.id SET c.versao_ativa_id=v.id,c.status='active' WHERE c.versao_ativa_id IS NULL AND v.versao=1;
--> statement-breakpoint
UPDATE `prompts_versoes` pv INNER JOIN `prompts_agentes` p ON p.id=pv.prompt_id INNER JOIN `prompts_contratos` c ON c.chave=CASE WHEN p.chave IN ('analista.primeira_rodada_tarefa','analista.retomada_apos_clarificacao') THEN 'analista.plano_ou_perguntas' WHEN p.chave IN ('dev.primeira_rodada_tarefa','dev.retorno_por_falha_de_gate') THEN 'dev.resultado_execucao' WHEN p.chave='monitor.classificacao_falha_de_gate' THEN 'monitor.veredito_gate' END SET pv.contrato_versao_id=c.versao_ativa_id WHERE pv.contrato_versao_id IS NULL;
