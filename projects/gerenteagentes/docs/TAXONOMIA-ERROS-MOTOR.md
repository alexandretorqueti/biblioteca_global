# Taxonomia de Erros do Motor — "Bloqueio é Exceção"

> Princípio (Alexandre, 2026-10-29): **bloqueio deveria ser exceção, não regra.**
> Erro de infraestrutura do motor não é falha do trabalho do agente e não pode
> fabricar bloqueio. Implementado na melhoria #4 do ciclo manual
> (branch `fix/controle-operador-monitor`).

## As três categorias

| Categoria | O que é | Tratamento | Consome attempt? | Gera bloqueio? |
|---|---|---|---|---|
| `infra` | Falha da infraestrutura do motor: MySQL fora/deadlock/lock-wait/timeout, duplicate em `motor_outbox`/`motor_message_processing_state` (redelivery/idempotência), RabbitMQ (channel closed, connection lost, ECONNREFUSED), DNS/rede, locks do motor (`.motor-v3-*.lock`) | **Retry transparente com backoff** (adiamento via outbox, 5s·2^n, teto 300s) | ❌ não | ❌ nunca |
| `capacity` | Ambiente/capacidade: Console ocupado, HTTP 429/502/503/504, provider indisponível/sobrecarregado, rate-limit | **Espera com backoff** (mesmo mecanismo do infra) | ❌ não | ❌ nunca (via fila) |
| `work` | Problema real do trabalho: código, testes, verificação, gate de migrations, schema | Retry do broker histórico; ao atingir `maxAttempts` → DLQ + `SubtaskTerminalFailureBlocker` (bloqueio + TASK_BLOCKED + monitor) | ✅ sim | ✅ sim (único caminho) |

## Implementação

- **`motor-v3/src/queue/ErrorTaxonomy.ts`** — `classifyMotorError(error)` /
  `classifyMotorErrorDetail(error)` (com evidência para auditoria). Inspeciona
  `code`/`errno`/`status` (mysql2, Node, HTTP), texto da mensagem e a cadeia de
  `cause` (até 5 níveis). `ER_DUP_ENTRY` só é infra quando a colisão é em tabela
  de infra de mensagens; em tabela de negócio segue como `work`.
- **`QueueConsumer`** (entrada única de mensagens duráveis): no catch do
  handler, erro `infra`/`capacity` → `deferTransientFailure()`:
  - adia a mensagem via outbox (mesmo messageId, `defer_count` com backoff
    exponencial, `status='pending'`, **attempt preservado**);
  - após `MOTOR_TRANSIENT_MAX_DEFERS` (padrão **40**; ~5s→300s ≈ 3h de espera)
    → DLQ com reason `infra-retry-exhausted`/`capacity-retry-exhausted`,
    **sem** `TerminalFailureHandler` → **sem bloqueio**. A superfície para o
    operador é o `DlqReconciler` + alerta Telegram de DLQ (melhoria #3);
  - se o próprio adiamento falhar (banco fora junto) → `nack` devolve ao
    broker (último recurso durável).
- **`SubtaskTerminalFailureBlocker`** (defesa em profundidade): erro `infra`
  que chegar ao caminho terminal por rota legacy não persiste bloqueio nem
  emite TASK_BLOCKED. `capacity` mantém comportamento histórico nesse ponto
  (só alcançável fora da fila).

## Interação com as outras melhorias do ciclo

- **#2 MonitorMissionRecoveryReconciler:** bloqueio criado só pode ser de
  `work` (ou histórico); o recovery continua fechando missões órfãs.
- **#3 DlqReconciler:** mensagens `*-retry-exhausted` caem na DLQ; o
  reconciliador classifica contra o banco e re-enfileira (máx. 2) ou arquiva,
  e o alerta de profundidade avisa o operador — o loop de supervisão de infra
  fecha SEM a estação de bloqueios.

## Configuração

| Env | Padrão | Efeito |
|---|---|---|
| `MOTOR_TRANSIENT_MAX_DEFERS` | `40` | Máximo de adiamentos consecutivos por erro infra/capacity antes da DLQ sem bloqueio |

## Testes

- `test/error-taxonomy.test.ts` — classificação (códigos MySQL/rede/amqp,
  dup entry infra vs negócio, capacity HTTP/Console/provider, cause chain,
  limite de profundidade).
- `test/queue-consumer-transient-retry.test.ts` — adiamento sem consumir
  attempt, teto → DLQ sem handler terminal, work mantém nack/DLQ+handler,
  falha do adiamento → nack.
- `test/subtask-terminal-failure-blocker.test.ts` — infra omitido no caminho
  terminal (inclusive embrulhado em `cause`).
