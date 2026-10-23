-- Idempotência lógica do outbox (task-p2-1031): defer_count para backoff e
-- chave única (type, task_id, correlation_id).
-- Correção (Monitor, 2026-10-23): a produção acumulou ~240k duplicados do loop
-- de requeue do blocker (bug corrigido em d5b3128b, 20-21/10). O ADD UNIQUE
-- direto falha com errno 1062, o drizzle-kit aborta com exit 1 sem mensagem e
-- o api-green nunca fica saudável — foi a causa das falhas blue-green dos
-- batches deploy-26547bfa (task-p2-1031) e deploy-b1ec0155 (task-p2-1041).
-- Deduplicar antes de criar a chave: mantém o registro mais recente (MAX(id))
-- por chave lógica com correlation_id NOT NULL (NULLs não colidem em índice
-- único MySQL). Somente linhas já publicadas são afetadas (histórico de
-- entrega; não há pending no outbox).
DELETE o FROM `motor_outbox` o
JOIN (
  SELECT `type`, `task_id`, `correlation_id`, MAX(`id`) AS keep_id
    FROM `motor_outbox`
   WHERE `correlation_id` IS NOT NULL
   GROUP BY `type`, `task_id`, `correlation_id`
  HAVING COUNT(*) > 1
) d ON o.`type` = d.`type` AND o.`task_id` = d.`task_id` AND o.`correlation_id` = d.`correlation_id`
WHERE o.`id` < d.keep_id;
--> statement-breakpoint
ALTER TABLE motor_outbox
  ADD COLUMN defer_count int NOT NULL DEFAULT 0 AFTER attempt,
  ADD UNIQUE KEY motor_outbox_logical_key_unique (type, task_id, correlation_id);
