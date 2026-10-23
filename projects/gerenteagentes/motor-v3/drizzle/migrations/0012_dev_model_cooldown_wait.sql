-- Espera durável de capacidade por cooldown de modelos DEV (tarefa task-p2-1041).
-- Acrescenta motivo de espera 'model_cooldown' com prazo de nova tentativa
-- (capacity_wait_retry_at), relógio da espera (capacity_wait_since) e controle
-- de alerta único (capacity_wait_alert_at) em task_runtime_facts.
-- Idempotente de propósito: as MESMAS colunas também existem em
-- projects/gerenteagentes/migrations/0094_motor_capacity_wait_cooldown.sql
-- (aplicada pelo drizzle-kit no deploy, com `when` menor que o desta entrada).
-- Os dois folders compartilham __drizzle_migrations no banco do projeto
-- (incidente task-p2-989), então esta migration pode rodar antes OU depois da
-- 0094 — precisa ser no-op quando as colunas já existirem.
-- MySQL 8 NÃO aceita ADD COLUMN IF NOT EXISTS (sintaxe MariaDB, errno 1064);
-- o padrão idempotente compatível é checar information_schema e executar o DDL
-- via prepared statement (mesmo padrão da 0010_capacity_wait_fact).
SET @motor_cooldown_wait_cols := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'task_runtime_facts'
     AND column_name IN (
       'capacity_wait_since',
       'capacity_wait_retry_at',
       'capacity_wait_alert_at'
     )
);
--> statement-breakpoint
SET @motor_cooldown_wait_ddl := IF(
  @motor_cooldown_wait_cols = 0,
  'ALTER TABLE `task_runtime_facts` ADD COLUMN `capacity_wait_since` datetime NULL, ADD COLUMN `capacity_wait_retry_at` datetime NULL, ADD COLUMN `capacity_wait_alert_at` datetime NULL',
  'DO 0'
);
--> statement-breakpoint
PREPARE motor_cooldown_wait_stmt FROM @motor_cooldown_wait_ddl;
--> statement-breakpoint
EXECUTE motor_cooldown_wait_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE motor_cooldown_wait_stmt;
--> statement-breakpoint
SET @motor_cooldown_scope_ddl := IF(
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'task_runtime_facts'
       AND column_name = 'capacity_wait_limit_scope'
       AND COLUMN_TYPE NOT LIKE '%model%'
  ),
  'ALTER TABLE `task_runtime_facts` MODIFY COLUMN `capacity_wait_limit_scope` enum(''global'',''project'',''provider'',''model'') NULL',
  'DO 0'
);
--> statement-breakpoint
PREPARE motor_cooldown_scope_stmt FROM @motor_cooldown_scope_ddl;
--> statement-breakpoint
EXECUTE motor_cooldown_scope_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE motor_cooldown_scope_stmt;
