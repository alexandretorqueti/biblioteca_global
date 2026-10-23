-- Mesmas alterações da externa
-- projects/gerenteagentes/migrations/0094_motor_outbox_deferred_idempotency.sql
-- (task-p2-1031). Os dois folders compartilham __drizzle_migrations no banco do
-- projeto (incidente task-p2-989) e o bootstrap do motor aplica por HASH do
-- conteúdo: esta migration pode rodar ANTES ou DEPOIS da externa — precisa ser
-- no-op quando defer_count já existir (padrão 0010/0012).
-- Correção (Monitor, 2026-10-23): a versão original era um ALTER
-- incondicional — (a) quebrava o boot do motor quando a externa já havia
-- aplicado (duplicate column) e (b) falhava com errno 1062 nos ~240k
-- duplicados de produção do loop de requeue (bug corrigido em d5b3128b).
-- Quando aplica de fato (coluna ausente), deduplica antes da chave única,
-- mantendo MAX(id) por (type, task_id, correlation_id).
-- MySQL 8 NÃO aceita ADD COLUMN IF NOT EXISTS (sintaxe MariaDB, errno 1064);
-- o padrão idempotente compatível é checar information_schema e executar via
-- prepared statement. O bootstrap aplica os statements em ordem na MESMA
-- conexão (applyMigration), então as variáveis de sessão sobrevivem entre os
-- statement-breakpoints.
SET @motor_outbox_defer_count := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'motor_outbox'
     AND column_name = 'defer_count'
);
--> statement-breakpoint
SET @motor_outbox_dedup_ddl := IF(
  @motor_outbox_defer_count = 0,
  'DELETE o FROM `motor_outbox` o JOIN (SELECT `type`, `task_id`, `correlation_id`, MAX(`id`) AS keep_id FROM `motor_outbox` WHERE `correlation_id` IS NOT NULL GROUP BY `type`, `task_id`, `correlation_id` HAVING COUNT(*) > 1) d ON o.`type` = d.`type` AND o.`task_id` = d.`task_id` AND o.`correlation_id` = d.`correlation_id` WHERE o.`id` < d.keep_id',
  'DO 0'
);
--> statement-breakpoint
PREPARE motor_outbox_dedup_stmt FROM @motor_outbox_dedup_ddl;
--> statement-breakpoint
EXECUTE motor_outbox_dedup_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE motor_outbox_dedup_stmt;
--> statement-breakpoint
SET @motor_outbox_deferred_ddl := IF(
  @motor_outbox_defer_count = 0,
  'ALTER TABLE `motor_outbox` ADD COLUMN `defer_count` int NOT NULL DEFAULT 0 AFTER `attempt`, ADD UNIQUE KEY `motor_outbox_logical_key_unique` (`type`, `task_id`, `correlation_id`)',
  'DO 0'
);
--> statement-breakpoint
PREPARE motor_outbox_deferred_stmt FROM @motor_outbox_deferred_ddl;
--> statement-breakpoint
EXECUTE motor_outbox_deferred_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE motor_outbox_deferred_stmt;
