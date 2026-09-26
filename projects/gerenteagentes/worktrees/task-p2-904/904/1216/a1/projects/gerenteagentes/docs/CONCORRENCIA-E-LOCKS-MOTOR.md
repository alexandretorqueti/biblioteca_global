# Concorrência e Locks do Motor-v2

> Criado em 2026-09-10 após auditoria de condições de corrida nas correções do dia
> (leitura dinâmica de config, pause, remoção do lease de execução por projeto,
> escalonamento de modelos, seleção duplicada, worker_exit).

## ⚠️ Premissa estrutural: INSTÂNCIA ÚNICA

**O motor-v2 foi desenhado para rodar em UMA única instância** (container
`biblioteca-global-api`, serviço `api` do compose da biblioteca-global).

Vários guardas de concorrência são **em memória** e só funcionam dentro de um
único processo Node:

| Guarda | O que protege |
|---|---|
| `pumping` (boolean) | Reentrância do `pump()` — check-then-set síncrono, seguro no single-thread do Node |
| `activeWorkers` (Map) | Contagem de vagas (`maxWorkers`/`maxWorkersPerProject`), seleção duplicada de subtarefas/tarefas |
| `finalizingExecutions` (Set) | Dupla finalização do mesmo worker (completed + worker_exit, timeout, etc.) |
| `processingDeployQueue` (boolean) | Reentrância do `processDeployQueue` (roda fora do guarda `pumping`) |
| `consoleIncidents` (Map) | Incidentes por agente (fila pausada) |

**Se o container `api` for escalado para 2+ réplicas, cada réplica rodará um
motor independente e esses guardas NÃO protegerão nada.** Nesse cenário seria
obrigatório migrar toda a coordenação para locks de banco (leases já existem
em `execution_resources`) antes de escalar.

## Locks de banco (ResourceLeaseService)

| Recurso | Chave | Onde é usado |
|---|---|---|
| Análise (global, exclusivo) | `motor:analysis` | `startTaskAnalysis` — apenas uma análise por vez no motor |
| Integração/promoção por projeto | `project:<slug>:integration` | `withProjectIntegrationLock` ao redor de `promoteTaskBranch` |
| Execução por projeto | `project:<slug>:execution` | **REMOVIDO em 2026-09-10** (commit `10d6d97`) — o paralelismo por projeto é controlado por `motor.max_workers_per_project` contando `activeWorkers` |

### Por que a promoção precisa de lock

`promoteTaskBranch` executa **no repositório principal** (não em worktree):

```
git switch <baseBranch> → git merge --no-ff <taskBranch> → git push origin <baseBranch>
```

O working tree principal é único. Duas promoções concorrentes do mesmo projeto
(interleaving de switch/merge) corromperiam o estado do repo. Com a remoção do
lease de execução, duas tarefas do mesmo projeto podem completar ao mesmo
tempo — por isso o lease `project:<slug>:integration` foi introduzido
(commit da auditoria de 2026-09-10). A chave já existia no catálogo
(`RESOURCE_KEYS.projectIntegration`) mas nunca tinha sido ligada.

A aquisição usa `tryAcquire` (sem fila) com retry de 2s por até ~5 minutos —
a promoção leva segundos, então a contenção é rara e curta.

## Condições de corrida conhecidas e tratadas

### 1. Seleção duplicada de subtarefa (commit `4cfefd2`)
`startSubtaskExecution` adiciona ao `activeWorkers` (síncrono) ANTES de
atualizar `subtarefas.status='running'` (assíncrono). `selectNextSubtask` e
`selectNextTask` filtram contra `activeWorkers` para fechar a janela.

### 2. worker_exit vs completed (commits `b33775d` + auditoria)
O worker envia `completed` e sai 1s depois. O coordenador pode ainda estar no
`finishWorker` (limpeza de workspace) quando o `exit` chega. O handler:
1. Se `finalizingExecutions` tem o id → loga como esperado e retorna.
2. Se code 0 → `recoverSilentCodeZeroExit`: consulta o banco; se a subtarefa
   está `verified`/`delivered` recupera o sha da branch do worktree e chama
   `onTaskCompleted`; se análise persistiu plano, chama `onTaskCompleted`; se
   há clarificação pendente, chama `onTaskClarifying`; só então falha.
3. Se code ≠ 0 → falha imediata.

### 3. pauseTask vs resumeNext (commit da auditoria)
Pause de tarefa aguardando recurso: `DELETE` da fila + `UPDATE paused_at` em
transação única com `SELECT ... FOR UPDATE` na linha da tarefa. `resumeNext`
já usava `FOR UPDATE` na mesma linha → serializados no banco.
O caminho graceful (`pendingPause` no `onTaskCompleted`) também limpa
`resource_wait_*` para a tarefa não voltar a ser selecionada.

### 4. processDeployQueue concorrente (commit da auditoria)
Flag em memória `processingDeployQueue` + reivindicação atômica do lote:
`UPDATE ... WHERE status='pending'` com checagem de `affectedRows > 0` antes
de despachar o script de deploy via SSH.

### 5. Escalonamento de modelo na análise (commit `55b9cbc`)
Erro de autenticação/indisponibilidade durante o envio de contexto agora é
detectado (códigos `missing-provider-auth`, `provider_auth_error`, padrões
"no api key found" etc.) e faz `continue` para o próximo modelo da cadeia,
com evento `model_unavailable` — em vez de propagar exceção e falhar a tarefa.

## Operações git e sua segurança

| Operação | Onde roda | Concorrência |
|---|---|---|
| `promoteTaskBranch` (switch+merge+push) | Repo principal | **Lock de banco obrigatório** (`project:<slug>:integration`) |
| `ensureTaskIntegration` (worktree add da tarefa) | `.git` do repo principal | Git usa locks internos em `.git/worktrees`; não toca o HEAD principal |
| `prepare` (worktree add da subtarefa) | `.git` do repo principal | Idem |
| `integrateIntoTaskBranch` (merge subtarefa→tarefa) | Worktree da tarefa (exclusivo por tarefa) | Tarefas diferentes = worktrees diferentes; mesma tarefa = subtarefas sequenciais |
| `publishBranch` (push) | Qualquer worktree | Refs do git têm lock próprio |
| `purgeTaskArtifacts` (worktree remove) | Repo principal | Roda como manutenção; git locka `.git/worktrees` |
