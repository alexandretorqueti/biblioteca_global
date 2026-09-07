# Fluxo e contrato de observabilidade do Motor v2

**Contrato:** `execution_event` v1, implementado em `src/events/execution-event.ts`.

## Identidade e correlação

`event_id` identifica a ocorrência; `correlation_id` agrupa todos os eventos de
uma execução lógica. `task_id` e `subtask_id` são FKs inteiras internas e
imutáveis. O número sequencial, slug ou texto exibido (`st-1`, por exemplo)
não é chave de auditoria. `attempt_id` aponta para a tentativa persistida e é
nulo somente em eventos de planejamento/tarefa sem tentativa.

`execution_id` é o identificador do processo/worker (`exec-execute-*` hoje),
mas não substitui `attempt_id`. `workspace_commit` registra o commit observado
no ponto do evento, não um commit inferido posteriormente.

## Fluxo atual e pontos de instrumentação

| Etapa | Ponto atual | Estado/dado atual | Evento a emitir |
| --- | --- | --- | --- |
| Seleção | `TaskCoordinator.pump`, `selectNextTask`/`selectNextSubtask` | tarefa/subtarefa elegível | `task_status_changed` ou `subtask_status_changed` quando houver transição |
| Planejamento | `startTaskAnalysis` + `PlanPersistence.persistPlan` | `planned → analyzing → ready`; cria `subtarefas` como `pending` | `task_status_changed` por transição |
| Início | `startSubtaskExecution` | adquire lease, grava `subtarefas.status='running'`, cria workspace e worker | `attempt_started`, `subtask_status_changed` |
| Execução | `TaskWorker.phaseExecute` e `ExecutionEventBus` | chamadas do agente, heartbeat, logs e progresso | eventos de status; atividade realtime continua separada |
| Gate da subtarefa | `TaskWorker` (`phaseVerify`, comandos build/test) | aprovação, reprovação, fingerprint e retorno para rework; histórico em `subtarefas_entregas` | `gate_started`, `gate_finished`, `delivery_rejected` ou `delivery_accepted` |
| Falha/retomada | `onTaskFailed`, `onTaskPaused`, `resumeTask`, watchdog e lease | `failed/paused/pending`, cancelamento, timeout ou saída inesperada | `attempt_finished`, `execution_paused`, `execution_resumed` |
| Bloqueio | `persistTaskBlock`, tratamento de falha em prepare/integração/deploy | linha em `bloqueios` com motivo, fingerprint e evidência resumida | `block_opened`; resolução deve emitir `block_resolved` |
| Entrega | `onTaskCompleted`, `recordSubtaskDeliveryEvent` | commit, `subtarefas_entregas`, merge na branch da tarefa | `delivery_started`, `delivery_accepted` |
| Gate de integração | `runTaskIntegrationGate`, `handleTaskIntegrationGateFailure` | build/test após cada merge; conflito/reversão pode re-enfileirar | `gate_started`, `gate_finished`, `delivery_rejected` |
| Aceite | `onTaskCompleted`, promoção após gates | `subtarefa.status='verified'`, `finalizada_em`; tarefa avança quando não há pendências | `subtask_status_changed`, `attempt_finished` |
| Deploy | `enqueueDeploy`, `processDeployQueue`, `dispatchDeployBatch`, `reconcileRunningDeploys` | `deploy_requests` pending/running/succeeded/failed; tarefa vira `deployed` só no sucesso remoto | `deploy_requested`, `deploy_started`, `deploy_finished` |
| Pós-deploy | status remoto atual e smoke test futuro | hoje não há smoke test persistido; sucesso de deploy não é saúde pós-deploy | `smoke_test_started`, `smoke_test_finished` quando implementado |

### Caminhos obrigatórios

- Sucesso: `pending → running → verifying → verified`, entrega/merge e,
  quando aplicável, deploy seguido de smoke test.
- Reprovação e retrabalho: `verifying → rejected → pending/running`, nova
  tentativa com o mesmo `subtask_id` e `attempt_id` diferente.
- Bloqueio: qualquer etapa operacional pode abrir `blocked`; a retomada fecha
  o bloqueio antes de emitir `execution_resumed` e iniciar nova tentativa.
- Cancelamento, timeout, saída do worker, lease perdido e erro sistêmico
  encerram a tentativa com `attempt_finished` e razão específica.
- Conflito de integração re-enfileira a subtarefa; repetição pode escalar para
  bloqueio. Nenhum merge parcial é tratado como entrega aceita.
- Deploy falho mantém a tarefa fora de `deployed`; deploy concluído sem smoke
  aprovado é implantado, porém ainda não confiável.

## Taxonomia canônica

Para subtarefas, os estados de avanço são `pending`, `running`, `verifying`,
`verified`, `rejected`, `blocked`, `superseded` e `deployed`. `completed` e
`delivered` permanecem aceitos por compatibilidade do fluxo atual, mas não
substituem `verified` nos KPIs de aceite.

`deployada` é alias legado de `deployed`. Leituras devem chamar
`normalizeTaskStatus`/`normalizeSubtaskStatus`; novas escritas e eventos usam
somente `deployed`. O histórico legado não é atualizado ou apagado.

Os `event_type` e `reason_code` fechados estão definidos como unions no módulo
do contrato. Mensagens variáveis ficam em `payload.summary`; evidências devem
ser pequenas, sanitizadas e estruturadas em `payload.attributes`.

## Regras de persistência futuras

Cada mudança de estado deve gravar o evento na mesma unidade transacional da
mudança de estado. Gates devem gerar uma dupla start/finish e referenciar a
mesma tentativa. Bloqueios devem ter abertura e resolução distintas. Falha de
persistência de observabilidade não deve apagar nem mascarar a decisão de
negócio; deve gerar alerta operacional para retry/reconciliação.

O contrato é aditivo e versionado por `schema_version`; consumidores devem
rejeitar versão desconhecida sem interpretar silenciosamente campos novos.
