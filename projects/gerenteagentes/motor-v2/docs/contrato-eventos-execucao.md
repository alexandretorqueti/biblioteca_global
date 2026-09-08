# Contrato canônico de eventos de execução

## Identidade e correlação

`ExecutionEvent` é o contrato da futura tabela `execution_events`. Os campos
`task_id`, `subtask_id` e `attempt_id` referenciam as chaves primárias
imutáveis de `tarefas`, `subtarefas` e `execution_attempts`. Não usar
`external_id`, `seq`, `st-1` ou outro identificador textual como FK.

`event_id` é um UUID por evento. `execution_id` identifica a execução do
worker (pode ser nulo em eventos de fila/deploy sem worker) e
`correlation_id` é obrigatório para agrupar toda a operação, inclusive gates e
deploy. `workspace_commit` registra o commit observado no momento do evento,
quando existir.

`occurred_at` é o instante do fato; a persistência deve ser append-only. A
ordenação de uma operação é `(occurred_at, event_id)`, não a ordem de chegada
do realtime bus.

## Tipos de evento

| Grupo | `event_type` | Transição/uso |
|---|---|---|
| Execução | `task_started`, `task_paused`, `task_resumed`, `task_failed`, `task_completed`, `execution_cancelled`, `execution_error` | Ciclo da tarefa e encerramento do worker |
| Subtarefa | `subtask_started`, `subtask_retried`, `subtask_delivered`, `subtask_verified`, `subtask_rejected`, `subtask_blocked`, `subtask_superseded` | Tentativa, entrega, aceite e retrabalho |
| Gate | `gate_started`, `gate_passed`, `gate_failed` | Cada build, teste, lint, segurança, integração ou smoke test executado |
| Bloqueio | `blocker_opened`, `blocker_resolved` | Abertura e encerramento do ciclo de impedimento |
| Integração | `integration_conflict` | Merge da subtarefa na branch da tarefa recusado |
| Deploy | `deploy_requested`, `deploy_started`, `deploy_succeeded`, `deploy_failed` | Fila, execução e resultado do deploy |
| Pós-deploy | `smoke_test_passed`, `smoke_test_failed` | Validação independente; `deployed` não implica smoke aprovado |

## `reason_code`

Os valores são estáveis para SQL e agrupamento: `manual`, `worker_started`,
`retry_after_rejection`, `gate_passed`, `gate_failed`,
`blocked_environment`, `systemic_failure`, `model_chain_exhausted`,
`correction_failed`, `integration_conflict`, `timeout`, `lease_lost`,
`lease_expired`, `cancelled`, `paused`, `resumed`, `deploy_requested`,
`deploy_succeeded`, `deploy_failed`, `smoke_test_passed`,
`smoke_test_failed` e `invalid_transition`.

`actor_type` identifica `motor`, `agent`, `human` ou `system`; `agent_id` e
`model` são preenchidos quando conhecidos. Mensagens e saída de comandos não
fazem parte do contrato: evidência sanitizada deve ser limitada a
`gate_runs.evidence_json` ou armazenamento referenciado.

## Mapa do fluxo atual e pontos de instrumentação

O fluxo abaixo foi levantado no `motor-v2/src/coordinator/TaskCoordinator.ts`.
As linhas são referências do estado atual e podem mudar com novas edições.

1. **Planejamento/análise:** o pump seleciona tarefas `planned` e inicia o
   worker de análise; transições são centralizadas em `saveTaskTransition`
   (`start_analysis`, `analysis_completed`). Perguntas passam por
   `onTaskClarifying` e retomam via `resumeAnsweredClarifications`.
2. **Início da subtarefa:** `startSubtaskExecution` adquire lease, registra o
   worker, muda `subtarefas.status` para `running`, prepara worktree e chama o
   worker. Aqui nasce a `execution_attempt` e o evento
   `subtask_started`/`task_started` na instrumentação futura.
3. **Sucesso e gate:** `onTaskCompleted` recebe o commit, integra na branch da
   tarefa e executa `runTaskIntegrationGate` (build/test). A entrega é então
   marcada como aprovada/integrada; o aceite técnico deve emitir
   `gate_passed` e `subtask_verified`, nunca apenas o realtime `completed`.
4. **Reprovação/retrabalho:** `handleTaskIntegrationGateFailure` reverte o
   merge, registra digest/fingerprint e devolve a subtarefa a `pending`;
   `handleSubtaskIntegrationConflict` faz o mesmo para conflito de merge. A
   nova execução recebe outro `attempt_id`, mantendo a correlação da tarefa.
5. **Falha e bloqueio:** `onTaskFailed`, falhas de preparação em
   `startSubtaskExecution`, transições inválidas em `saveTaskTransition` e
   `failDeployBatch` persistem `bloqueios` e mudam tarefa/subtarefa para
   `blocked`. Cada abertura deve emitir `blocker_opened`; retomada após
   resolução emite `blocker_resolved` e `subtask_retried`/`task_resumed`.
6. **Pausa/cancelamento:** `onTaskPaused` devolve `running`/`verifying` a
   `pending` preservando o worktree; `resumeTask` aplica `resume` ou
   `resume_without_plan`. Cancelamentos e timeouts são encerramentos distintos
   e devem manter a tentativa com `outcome=cancelled` ou `error`.
7. **Conclusão e deploy:** `enqueueDeploy` cria a solicitação; o pump marca o
   lote `running`, `dispatchDeployBatch` executa o script remoto e
   `reconcileRunningDeploys` distingue sucesso de falha. O sucesso em
   `reconcileRunningDeploys` emite `deploy_succeeded` e pode mudar a tarefa para
   `deployed`; `failDeployBatch` emite `deploy_failed` e abre bloqueio. Smoke
   test, quando existir, é evento separado e decide confiabilidade pós-deploy.

## Regras de emissão

- Emitir um evento para cada mudança de estado, gate efetivamente executado,
  abertura/resolução de bloqueio e etapa de deploy; não inferir gate a partir
  de `ExecutionActivityEvent`.
- `from_status` e `to_status` são nulos quando o evento não for transição;
  em transições, ambos devem refletir o valor persistido, normalizando
  `deployada` para `deployed` em novas gravações/leitura analítica.
- O evento deve ser gravado na mesma unidade transacional da mudança de estado
  quando o driver permitir. Se a persistência falhar, o fluxo deve expor o
  erro e não fabricar aceite; o realtime pode continuar sendo best-effort.
- `reason_code` deve ser categorizável, sem colocar texto livre no lugar do
  enum. Fingerprints e evidências detalhadas pertencem aos registros próprios.

