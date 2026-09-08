# Mapeamento do fluxo de pausa e retomada do Motor

Subtarefa: task-p2-788 / 903 / a1 — botão de pausa.

## Resumo executivo

O botão de pausa atualmente interrompe o worker imediatamente. O ponto exato é
`TaskCoordinator.pauseTask()`: ele chama `workerLauncher.stopWorker()` antes de
persistir a pausa. `stopWorker()` envia `shutdown` ao processo filho; o
`TaskWorker` trata essa mensagem em `shutdown()` e executa `process.exit(0)`.
Portanto, a execução do agente atual não chega naturalmente ao fim da fase,
do gate ou da entrega.

Há também uma corrida que explica a tarefa aparecer como `blocked`: o evento
`worker_exit` é emitido quando o filho termina. O handler chama
`onTaskFailed()` se o worker ainda estiver em `activeWorkers`. Como
`pauseTask()` aguarda o `exit` e só depois chama `onTaskPaused()`, o handler de
saída pode finalizar primeiro e aplicar `fail`, que transiciona a tarefa para
`blocked`. Nesse caso `onTaskPaused()` pode encontrar o worker já finalizado e
não aplicar `pause`.

## Fluxo atual

1. A API da Biblioteca chama `POST /api/motor/task/:id/pause`.
2. `MotorAPI.handlePauseTask()` chama `TaskCoordinator.pauseTask()`.
3. `pauseTask()` localiza o worker ativo, chama `stopWorker()` e aguarda o
   processo filho sair.
4. `WorkerLauncher.stopWorker()` envia `{ type: 'shutdown' }`; após 10 s,
   pode usar `SIGKILL`.
5. O filho encerra sem enviar `completed`; o evento `worker_exit` pode chamar
   `onTaskFailed()`.
6. O caminho pretendido, `onTaskPaused()`, muda a subtarefa para `pending`,
   aplica `running|analyzing -> paused`, preserva o worktree e libera o lease.
7. `resumeTask()` calcula se existe plano persistido, aplica `paused -> ready`
   (com plano) ou `paused -> planned` (sem plano) e chama `pump()`.

## Estados e transições observados

### Tarefa

| Situação | Transição atual | Próximo estado | Origem |
|---|---|---|---|
| início da análise | `planned -> start_analysis` | `analyzing` | coordenador |
| análise concluída | `analyzing -> analysis_completed` | `ready` | evento `completed` |
| início de subtarefa | `ready -> start_execution` | `running` | `startSubtaskExecution()` |
| entre subtarefas | `running -> subtasks_pending` | `ready` | coordenador |
| pausa explícita | `analyzing/running -> pause` | `paused` | `onTaskPaused()` |
| retomada com plano | `paused -> resume` | `ready` | `resumeTask()` |
| retomada sem plano | `paused -> resume_without_plan` | `planned` | `resumeTask()` |
| falha não transitória | estados ativos/paused -> `fail` | `blocked` | `onTaskFailed()` ou falha de preparação |
| falha transitória | `analyzing/running -> recover` | `paused` | timeout, lease perdido, worker perdido |
| espera por recurso | qualquer fila de recurso -> `paused` | `paused` | `ResourceWaitManager` |
| recurso liberado | `paused -> ready/planned` | derivado da existência de subtarefas pendentes | `resumeNext()` |

`blocked` é reservado para falha persistida (ambiental, sistêmica,
preparação/gate ou integração). A pausa normal não deveria usar essa
transição.

### Subtarefa

No caminho de pausa, `running`, `verifying`, `delivered` ou `rework` volta para
`pending`. O `workspace` não é limpo, mas não há checkpoint persistido da fase
do agente, do `runId`, do gate ou do cursor da sessão.

## Execução sequencial e ponto de retomada

`pump()` limita o desenvolvimento por `maxWorkers` (padrão 1) e seleciona a
subtarefa pendente com menor `seq`, desde que não exista uma subtarefa anterior
não verificada. Após a retomada, o ponto efetivamente usado é:

```text
tarefa paused
  -> ready/planned
  -> pump()
  -> primeira subtarefa status=pending elegível por seq/dependências
```

Assim, o ponto de retomada é derivado dos estados persistidos da tarefa e das
subtarefas, não de um cursor do agente. Para uma subtarefa interrompida, o
Motor inicia uma nova execução desde o começo da subtarefa. O worktree
preservado pode conter alterações parciais, mas isso não equivale a um
checkpoint confiável de fase.

Para análise sem plano, a retomada reexecuta a análise. Para análise com plano,
o worker detecta o plano persistido e não replaneja; o pump segue para a
subtarefa pendente.

## Pontos relevantes para a correção posterior

- A pausa precisa ser um pedido cooperativo: registrar `pause_requested` e
  impedir novas seleções, mas deixar o worker terminar o agente/fase atual.
- O evento de conclusão/saída precisa ser classificado como encerramento
  solicitado pela pausa, antes de qualquer `onTaskFailed()`.
- A transição `blocked` deve continuar exclusiva para falhas reais; não deve
  ser consequência de `stopWorker()` usado pelo botão de pausa.
- Se o requisito for retomar no meio da mesma fase do agente, será necessário
  persistir checkpoint (fase, subtarefa, sessão/run e cursor seguro). O código
  atual não possui esse checkpoint; o comportamento implementado é retomar na
  subtarefa pendente desde o início.

## Evidências no código

- `motor-v2/src/coordinator/TaskCoordinator.ts:1338-1349`: botão de pausa
  para o worker antes de chamar `onTaskPaused`.
- `motor-v2/src/workers/WorkerLauncher.ts:133-145`: `stopWorker` envia
  `shutdown` e usa `SIGKILL` após timeout.
- `motor-v2/src/workers/TaskWorker.ts:250-260,1913-1917`: shutdown encerra o
  processo imediatamente.
- `motor-v2/src/coordinator/TaskCoordinator.ts:1639-1690`: `worker_exit`
  encaminha saída sem `completed` para falha.
- `motor-v2/src/coordinator/TaskCoordinator.ts:895-930`: falha não transitória
  marca subtarefa como `blocked` e aplica `fail -> blocked`.
- `motor-v2/src/coordinator/TaskCoordinator.ts:933-949`: caminho pretendido
  da pausa, reset para `pending`, transição para `paused` e preservação do
  worktree.
- `motor-v2/src/coordinator/TaskCoordinator.ts:201-243,308-326`: seleção
  sequencial do pump e critério de retomada por subtarefa pendente.
- `motor-v2/src/policies/TaskStateMachine.ts:9-76`: máquina de estados e
  transições oficiais.
- `motor-v2/src/resources/ResourceWaitManager.ts:20-38,66-115`: pausa
  legítima por espera de recurso e desbloqueio automático.
