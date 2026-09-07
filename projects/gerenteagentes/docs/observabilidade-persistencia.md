# Persistência de observabilidade do Motor

A migration `0024_motor_execution_observability.sql` é exclusivamente aditiva no schema `projeto_640`.
Ela adiciona baseline/peso a `tarefas` e `subtarefas`, ciclo de vida estruturado a `bloqueios`, e as tabelas
`execution_attempts`, `execution_events` e `gate_runs`. Todas as relações novas são indexadas para consultas por
subtarefa, tentativa, tipo de gate e período.

O serviço `ExecutionPersistenceService` centraliza a escrita parametrizada. Evidências são limitadas a 16 KiB;
quando excedem o limite, somente tamanho e SHA-256 são armazenados. A fingerprint de falha permite agrupar
repetições sem guardar saída potencialmente sensível.

## Rollback

Em janela controlada, executar `migrations/rollback/0024_motor_execution_observability.sql`. O rollback remove
somente tabelas e colunas criadas por esta migration; não modifica dados das tabelas legadas, mas naturalmente
descarta os dados de observabilidade coletados após a aplicação.

## Uso mínimo

1. `createAttempt` antes de iniciar a execução.
2. `recordEvent` para cada transição, sempre com `correlationId`.
3. `recordGate` para cada gate efetivamente executado.
4. `finishAttempt` com resultado, commits e consumo.
5. `openBlock`/`resolveBlock` para o ciclo de vida do bloqueio.
6. `recordDeploy` preenchendo smoke test separadamente; `deployed_at` não implica `smoke_test_ok`.
