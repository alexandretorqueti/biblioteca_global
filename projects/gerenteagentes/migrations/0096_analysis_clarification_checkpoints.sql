-- Retomada incremental da análise após clarificação (task-p2-1040).
--
-- 1) Tabela append-only de checkpoints: cada rodada de perguntas do analista
--    gera uma linha vinculando sessão/runtime, execução de análise que emitiu
--    as perguntas, execução de retomada (fencing), mensagem de resposta,
--    perguntas, resumo e evidências. Rodadas antigas transitam para
--    'superseded'/'consumed' — nunca são apagadas.
CREATE TABLE `analysis_clarification_checkpoints` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tarefa_id` bigint unsigned NOT NULL,
  `round_number` int NOT NULL DEFAULT 1,
  `session_key` varchar(300) NULL,
  `runtime_session_id` varchar(300) NULL,
  `model` varchar(200) NULL,
  `model_attempt` int NOT NULL DEFAULT 1,
  `analysis_attempt_id` varchar(100) NULL,
  `analysis_execution_id` varchar(200) NOT NULL,
  `resume_execution_id` varchar(200) NULL,
  `analyst_session_id` bigint unsigned NULL,
  `questions` json NOT NULL,
  `summary` text NULL,
  `evidence` json NULL,
  `answer_chat_message_id` bigint unsigned NULL,
  `status` varchar(30) NOT NULL DEFAULT 'awaiting_response',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `answered_at` timestamp NULL DEFAULT NULL,
  `consumed_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_clarification_checkpoints_tarefa_status` (`tarefa_id`, `status`),
  KEY `idx_clarification_checkpoints_execution` (`analysis_execution_id`),
  KEY `idx_clarification_checkpoints_resume` (`resume_execution_id`),
  CONSTRAINT `fk_clarification_checkpoints_tarefa` FOREIGN KEY (`tarefa_id`) REFERENCES `tarefas` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- 2) Nova versão do prompt de retomada: continuação contextual na mesma
--    sessão, sem reiniciar a investigação e sem repetir perguntas já
--    respondidas (salvo justificativa explícita no resumo).
INSERT INTO `prompts_versoes` (`prompt_id`, `versao`, `texto`, `contrato_versao_id`, `motivo`, `autor`, `validacao`)
SELECT p.id, COALESCE(MAX(previous.versao), 0) + 1,
  'Continue a análise da tarefa **TITULOTAREFA** (ID: **IDTAREFA**, tipo: **TIPOTAREFA**) a partir do contexto já investigado nesta sessão. Esta é uma retomada incremental após clarificação: NÃO reinicie a investigação, NÃO releia nem solicite o reenvio da descrição integral (ela já foi enviada nesta sessão; referência: **DESCRICAOTAREFA**) e NÃO repita análises já realizadas.\n\nHistórico completo de perguntas e respostas: **HISTORICOCLARIFICACAO**.\n\nIncorpore as novas respostas e continue de onde parou. Não repita perguntas já respondidas; só volte a perguntar algo já respondido se houver justificativa explícita registrada no resumo (por exemplo, resposta contraditória ou insuficiente). Novas perguntas somente se indispensáveis.\n\nSe o tipo for verificacao e a solicitação estiver clara, faça a verificação diretamente e retorne o parecer no contrato de verificação, sem criar subtarefas, sem acionar DEV e sem worktree. Caso contrário, devolva plano completo, executável e verificável, com requisitos e matriz de cobertura, preservando todos os requisitos e etapas.\n\n**CONTRATOSAIDA**',
  contract.versao_ativa_id, 'Retomada incremental após clarificação: continuação contextual na mesma sessão, sem reiniciar a investigação', 'sistema', JSON_OBJECT('ok', true)
FROM `prompts_agentes` p
JOIN `prompts_contratos` contract ON contract.chave = 'analista.plano_ou_perguntas'
LEFT JOIN `prompts_versoes` previous ON previous.prompt_id = p.id
WHERE p.chave = 'analista.retomada_apos_clarificacao'
GROUP BY p.id, contract.versao_ativa_id;
--> statement-breakpoint
UPDATE `prompts_agentes` p JOIN (SELECT prompt_id, MAX(id) AS version_id FROM `prompts_versoes` GROUP BY prompt_id) latest ON latest.prompt_id = p.id SET p.versao_ativa_id = latest.version_id WHERE p.chave = 'analista.retomada_apos_clarificacao';
