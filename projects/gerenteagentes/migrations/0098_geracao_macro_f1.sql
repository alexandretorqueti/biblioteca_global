-- Geração Macro F1 (task-p2-1056): religar a geração macro de tarefas
-- (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §3.1/§4).
--
-- Migration estritamente ADITIVA: CREATE TABLE + ALTER TABLE ADD COLUMN.
-- Nenhum DROP/RENAME/MODIFY de colunas existentes.
--
-- 1) lacunas_biblioteca: histórico acumulativo de funcionalidades que a
--    Biblioteca Global não cobre nativamente, apontadas pelo plano de geração
--    (§3.1 "Registro de lacunas" e §4). Alimentada na materialização do plano
--    aprovado; recorrência entre projetos = candidata a capacidade nativa
--    (insumo de roadmap da biblioteca).
--    status: aberta | absorver | adiar | recusada (varchar — sem DDL para
--    novos valores de decisão).
CREATE TABLE `lacunas_biblioteca` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `projeto_id` bigint unsigned NOT NULL,
  `geracao_id` bigint unsigned NOT NULL,
  `req_id` varchar(50) NULL,
  `funcionalidade` varchar(300) NOT NULL,
  `contexto` text NULL,
  `status` varchar(20) NOT NULL DEFAULT 'aberta',
  `decided_at` timestamp NULL DEFAULT NULL,
  `decided_by` varchar(200) NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lacunas_biblioteca_projeto` (`projeto_id`),
  KEY `idx_lacunas_biblioteca_status` (`status`),
  CONSTRAINT `fk_lacunas_biblioteca_projeto` FOREIGN KEY (`projeto_id`) REFERENCES `projetos_captados` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_lacunas_biblioteca_geracao` FOREIGN KEY (`geracao_id`) REFERENCES `geracoes_projeto` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
-- 2) geracoes_projeto: colunas NULLABLE de claim/lease do
--    ProjectGenerationWorker (padrão AnalysisClaimReconciler: running sem
--    worker vivo com lease expirado → volta para pending) e de feedback da
--    revisão humana (decisao=revise no endpoint de aprovação retorna a
--    geracao para running com o feedback registrado).
--    Fato verificado: a tabela atual NÃO tem colunas de lease; status é
--    varchar(50) e já comporta os novos valores (awaiting_approval, approved,
--    rejected) sem DDL; coluna tasks (json) já existe.
ALTER TABLE `geracoes_projeto`
  ADD COLUMN `worker_id` varchar(200) NULL,
  ADD COLUMN `claimed_at` timestamp NULL DEFAULT NULL,
  ADD COLUMN `lease_expires_at` timestamp NULL DEFAULT NULL,
  ADD COLUMN `feedback` text NULL;
