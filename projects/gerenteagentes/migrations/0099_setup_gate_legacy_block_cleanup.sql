-- Gate de execução do setup como espera de capacidade (task-p2-1056, subtarefa 6).
--
-- DECISÃO DO DEV (documentada também em
-- motor-v3/src/coordinator/MySqlTaskCoordinatorRepository.ts): o gate de
-- setup_status != 'verified' deixava de inserir bloqueio e passava a registrar
-- espera de capacidade (task_runtime_facts.capacity_wait_reason_code =
-- 'setup_not_verified', coluna varchar(40) — NÃO é enum, nenhum DDL é
-- necessário para o novo valor). docs/TAXONOMIA-ERROS-MOTOR.md reserva a
-- tabela `bloqueios` exclusivamente ao caminho 'work'; espera de
-- ambiente/capacidade nunca gera bloqueio.
--
-- Limpeza idempotente do legado: bloqueios abertos criados pela versão
-- anterior do gate (block_reason LIKE 'setup_not_verified:%') são resolvidos.
-- DML pura e re-executável (UPDATE com WHERE resolved_at IS NULL vira no-op
-- na segunda aplicação); nenhuma alteração de schema.
UPDATE `bloqueios`
   SET `resolved_at` = NOW()
 WHERE `resolved_at` IS NULL
   AND `block_reason` LIKE 'setup_not_verified:%';
