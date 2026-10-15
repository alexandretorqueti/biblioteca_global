-- Fato observável de espera por capacidade. O status da tarefa continua sendo
-- derivado dos fatos existentes; estas colunas apenas explicam por que a
-- próxima ação ainda não foi iniciada.
-- MySQL 8 NÃO aceita ADD COLUMN IF NOT EXISTS (sintaxe MariaDB) — o dry-run do
-- gate pre_deploy reprova com errno 1064. Padrão do projeto: ADD COLUMN simples
-- (como 0086/0088); a idempotência da dupla aplicação (esta entrada + a
-- interna 0010_capacity_wait_fact) é garantida pela migration interna, que é
-- condicional via prepared statement no bootstrap do motor.
ALTER TABLE `task_runtime_facts`
  ADD COLUMN `capacity_wait_phase` enum('analysis','development') NULL,
  ADD COLUMN `capacity_wait_reason_code` varchar(40) NULL,
  ADD COLUMN `capacity_wait_limit_scope` enum('global','project','provider') NULL,
  ADD COLUMN `capacity_wait_limit_value` int unsigned NULL,
  ADD COLUMN `capacity_wait_provider` varchar(120) NULL;
