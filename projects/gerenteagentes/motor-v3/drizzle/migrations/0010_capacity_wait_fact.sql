-- Explicação estruturada da espera por limite, sem criar um novo status de tarefa.
-- Idempotente de propósito: as MESMAS colunas também existem em
-- projects/gerenteagentes/migrations/0091_motor_capacity_wait_fact.sql (aplicada
-- pelo drizzle-kit no deploy). Os dois folders compartilham __drizzle_migrations
-- no banco do projeto (incidente task-p2-989), então esta migration pode rodar
-- antes OU depois da 0091 — precisa ser no-op quando as colunas já existirem.
-- MySQL 8 NÃO aceita ADD COLUMN IF NOT EXISTS (sintaxe MariaDB, errno 1064);
-- o padrão idempotente compatível é checar information_schema e executar o DDL
-- via prepared statement. O bootstrap aplica os statements em ordem na MESMA
-- conexão (applyMigration), então as variáveis de sessão sobrevivem entre os
-- statement-breakpoints.
SET @motor_capacity_wait_cols := (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'task_runtime_facts'
     AND column_name IN (
       'capacity_wait_phase',
       'capacity_wait_reason_code',
       'capacity_wait_limit_scope',
       'capacity_wait_limit_value',
       'capacity_wait_provider'
     )
);
--> statement-breakpoint
SET @motor_capacity_wait_ddl := IF(
  @motor_capacity_wait_cols = 0,
  'ALTER TABLE `task_runtime_facts` ADD COLUMN `capacity_wait_phase` enum(''analysis'',''development'') NULL, ADD COLUMN `capacity_wait_reason_code` varchar(40) NULL, ADD COLUMN `capacity_wait_limit_scope` enum(''global'',''project'',''provider'') NULL, ADD COLUMN `capacity_wait_limit_value` int unsigned NULL, ADD COLUMN `capacity_wait_provider` varchar(120) NULL',
  'DO 0'
);
--> statement-breakpoint
PREPARE motor_capacity_wait_stmt FROM @motor_capacity_wait_ddl;
--> statement-breakpoint
EXECUTE motor_capacity_wait_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE motor_capacity_wait_stmt;
