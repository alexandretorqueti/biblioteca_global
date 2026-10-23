-- Espera durável de capacidade por cooldown de modelos DEV (tarefa task-p2-1041).
-- Fatos observáveis em task_runtime_facts: relógio da espera (capacity_wait_since),
-- prazo previsto de nova elegibilidade (capacity_wait_retry_at) e controle de
-- alerta único para indisponibilidade prolongada (capacity_wait_alert_at).
-- O escopo do motivo (capacity_wait_limit_scope) ganha o valor 'model'
-- (reason_code é varchar e já comporta 'model_cooldown').
-- MySQL 8 NÃO aceita ADD COLUMN IF NOT EXISTS (sintaxe MariaDB) — o dry-run do
-- gate pre_deploy reprova com errno 1064. Padrão do projeto: ADD COLUMN simples
-- (como 0086/0088/0091); a idempotência da dupla aplicação (esta entrada + a
-- interna motor-v3/drizzle/migrations/0011_dev_model_cooldown_wait.sql) é
-- garantida pelo ordenamento (`when` desta entrada é MENOR que o da interna) e
-- pela migration interna, que é condicional via prepared statement no bootstrap
-- do motor — mesmo mecanismo do par 0091/0010.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN `capacity_wait_since` datetime NULL,
  ADD COLUMN `capacity_wait_retry_at` datetime NULL,
  ADD COLUMN `capacity_wait_alert_at` datetime NULL,
  MODIFY COLUMN `capacity_wait_limit_scope` enum('global','project','provider','model') NULL;
