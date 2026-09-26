# Invariante de Conclusão de Tarefas — Desenho A+B+C

> Data: 2026-09-25 · Autor: Gerente de Agentes (com aprovação do Alexandre)
> Incidente motivador: tarefa 820 (`task-p2-820`)

## O incidente

Em 2026-09-25 17:37 UTC, uma intervenção externa (`resolvedBy: external_monitor_resolution`)
resolveu os bloqueios 2359/3213 da tarefa 820 e marcou a última subtarefa (1050) como
`verified` **via SQL direto**, contornando a transação do motor que:

1. grava `task_runtime_facts` (`terminal_status='completed'`, `integration_confirmed_at`);
2. emite `TASK_EXECUTION_COMPLETED` e `DEPLOY_REQUESTED` no outbox.

Resultado: tarefa com todas as subtarefas finais, sem fatos de conclusão, sem deploy,
status derivado `ready` — presa para sempre. A tentativa de re-enfileiramento
(`TASK_READY_FOR_PROGRAMMING` 17:38/17:39) esbarrou em `project_limit` e a tarefa entrou
em `motor_execution_wait_queue`, mas `wakeCapacityWaiters` exigia `EXISTS (subtarefas
pending)` — filtro que uma tarefa toda verificada nunca satisfaz. Zumbi permanente.

**Invariantes violados:** "todas as subtarefas finais ⇒ tarefa concluída" e
"tarefa na wait queue ⇒ eventualmente acordada".

## O desenho A+B+C (defesa em profundidade, sem execução periódica)

### Camada A — Trigger de rede de segurança (`trg_subtarefas_completion_net`)

`AFTER UPDATE ON subtarefas`: quando o novo status é final (`verified`/`superseded`),
houve mudança de status, não restam subtarefas não-finalizadas e não há
`terminal_status` gravado, o trigger:

- grava `task_runtime_facts` (`completed` + `integration_confirmed_at`) via upsert;
- insere `DEPLOY_REQUESTED` no outbox com **message_id determinístico**
  (`deploy-completed-trigger-<tarefa_id>`; `INSERT IGNORE` no UNIQUE deduplica re-disparos),
  somente para `tipo='desenvolvimento'` e tarefa não pausada.

**Supressão:** os caminhos canônicos do motor definem `SET @motor_completing := 1` na
mesma conexão antes de atualizar subtarefas (e limpam no `finally`). O trigger ignora
escritas do próprio motor — sem mensagens duplicadas no fluxo normal.

**Instalação:** não pode ser migration drizzle — `CREATE/DROP TRIGGER` não é suportado
pelo protocolo de prepared statements (`ER_UNSUPPORTED_PS`), que é o caminho do
`drizzle-kit migrate`. Por isso a instalação roda no **boot do motor-v3**
(`src/db/ensureTriggers.ts` → `ensureCompletionTrigger(pool)`), via `pool.query()`
(protocolo de texto), com `GET_LOCK('gerente…gers', 30)` para
serializar blue/green e `DROP+CREATE` idempotente (autocura se o trigger for removido).
Falha na instalação NÃO derruba o boot (B e C seguem protegendo), mas é logada em destaque.

**Pré-requisito de infraestrutura (aplicado em 2026-09-25):** MySQL com `log_bin=ON`
exige SUPER para criar triggers salvo `log_bin_trust_function_creators=1`. Como não há
réplicas (`SHOW REPLICAS` vazio), foi aplicado `SET PERSIST log_bin_trust_function_creators=1`
no `biblioteca-global-mysql`. Reversível com `SET PERSIST log_bin_trust_function_creators=0`.

**Limitação conhecida (aceitável):** duas subtarefas finais commitadas simultaneamente em
transações concorrentes podem ambas não ver o conjunto completo (leitura consistente do
trigger) e nenhuma concluir — nesse caso a camada B resolve na próxima mensagem.

### Camada B — Fallback de reconciliação no fluxo de execução

`MySqlDevelopmentExecutionRepository.reserveNextSubtask()`: logo após o lock da tarefa e
**antes dos limites de capacidade** (conclusão não precisa de worker),
`completeIfAllSubtasksFinal()` detecta "todas as subtarefas finais + sem terminal_status"
e reconcilia na mesma transação: facts de conclusão + `TASK_EXECUTION_COMPLETED` +
`DEPLOY_REQUESTED` (para `tipo='desenvolvimento'`) + remoção da wait queue + wake dos
demais waiters. Retorna `{ kind: 'task_completed' }`; o `DevelopmentExecutionConsumer`
registra a operação (`complete_task_by_reconciliation`).

`wakeCapacityWaiters()`: o filtro `EXISTS (pending)` virou
`EXISTS (pending) OR (todas finais sem terminal_status)` — zumbis como a 820 voltam a
receber `TASK_READY_FOR_PROGRAMMING` quando a capacidade libera, e o fallback acima os
conclui.

### Camada C — Endpoint de resolução externa governada

`POST /api/motor/task/:id/external-resolution` (`src/monitor/ExternalResolutionHandler.ts`):

```json
{
  "motivo": "descrição humana da intervenção (obrigatório)",
  "resolvedBy": "identificação do ator (obrigatório)",
  "blockIds": [123],            // opcional; ausente = todos os bloqueios ativos da tarefa
  "subtaskId": 1050,            // opcional; marca como verified (idempotente)
  "requestDeploy": false        // true → emite DEPLOY_REQUESTED (motor deploya pelo fluxo normal)
}
```

Tudo em uma transação, com `@motor_completing := 1` (suprime o trigger):

1. resolve bloqueios (`resolved_at`);
2. opcionalmente verifica a subtarefa informada;
3. se todas as subtarefas ficaram finais: grava facts de conclusão
   (`completed` + `integration_confirmed_at`), emite `TASK_EXECUTION_COMPLETED`,
   emite `DEPLOY_REQUESTED` apenas com `requestDeploy:true`, remove zumbi da wait queue;
   senão: emite `TASK_READY_FOR_PROGRAMMING` (devolve ao fluxo normal);
4. havendo bloqueios resolvidos: emite `TASK_UNBLOCKED` (auditoria/retomada do monitor);
5. grava auditoria em `tarefa_eventos` (`evento='external_resolution'`, `ator=resolvedBy`).

Erros: `not_found`/`subtask_not_found` → 404; `invalid_input` → 400.

**Regra de governança:** intervenção externa (humano ou agente) NUNCA deve escrever SQL
direto em `subtarefas`/`bloqueios`/`task_runtime_facts`. Use este endpoint — ele mantém o
invariante por construção.

## Interação entre as camadas

| Cenário | Quem resolve |
|---|---|
| Fluxo normal do motor | Transação canônica (trigger suprimido) |
| Escrita externa futura via SQL direto (bypass de C) | **A** no momento da escrita |
| Estado herdado corrompido (ex.: 820 antes do fix) | **B** na próxima mensagem / **C** sob demanda |
| Tarefa zumbi na wait queue | wake corrigido + **B** |
| Intervenção externa correta | **C** |

## Ação corretiva aplicada (tarefa 820)

1. `POST external-resolution` (motivo: intervenção externa de 17:37 já integrada e
   deployada manualmente) → facts de conclusão gravados, sem `DEPLOY_REQUESTED`
   (integração já estava em produção);
2. registro único em `deploy_requests` com `status='succeeded'`
   (commit `43aa19c` — merge da integração da 820 na base, deployado no blue em
   2026-09-25 14:29 BRT) → status derivado final: `deployed`, e a recuperação de boot
   (`enqueueCompletedRecoveries`) não re-pede deploy de código que já está em produção.

## Fora do escopo (viram tarefas próprias)

- Tarefa 829: `ready` com 3 subtarefas pending desde 13/09 (bloqueio resolvido sem
  re-enfileiramento na era v2; `auto_start=0`). Retomar manualmente (UI ou
  `external-resolution` sem subtaskId → re-enfileira).
- Tarefa 873 e resoluções do monitor: cadeia de modelos inclui
  `deepseek/deepseek-v4-flash` (`model not allowed` no Console). Corrigir seleção de
  modelos; `TaskUnblockedConsumer` noop para `systemic_failure` merece re-enfileiramento.
- Migration `0068_uniform_collation` segue não registrada no journal drizzle (mesma
  limitação de prepared statements — precisa do mesmo tratamento de boot se algum dia
  for aplicada).
- `PUMP_TRIGGERED` não tem consumidor no motor-v3 (dead letter).

## Testes

- Unit (vitest): `test/ensure-triggers.test.ts` (lock/instalação/falha),
  `test/external-resolution.test.ts` (7 cenários do endpoint),
  `test/development-execution-consumer.test.ts` (caso `task_completed`).
- Integração real (MySQL scratch `motor_trigger_test`, 8 cenários): instalação via dist
  compilado, idempotência, conclusão por escrita externa, supressão por
  `@motor_completing`, dedupe de outbox, tarefa pausada, tipo≠desenvolvimento.
- Suíte completa motor-v3: 46 arquivos / 301 testes verdes.
