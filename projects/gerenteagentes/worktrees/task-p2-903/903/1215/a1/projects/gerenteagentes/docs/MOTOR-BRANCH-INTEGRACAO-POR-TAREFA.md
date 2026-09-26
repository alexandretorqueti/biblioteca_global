# Motor-v2 — Branch de integração por tarefa + P1 (baseline stash, carry-over)

> Status: **implementado** na branch `feature/motor-p1-baseline-integracao` (empilhada
> sobre o P0 `feature/motor-p0-classificador-gate`, commit `a1fc09b`).
> Decisões: Alexandre, 2026-09-05 (07:15 → 07:35). Origem: investigação da tarefa 760
> (`docs/INVESTIGACAO-TAREFA-760-POR-QUE-O-MOTOR-NAO-RESOLVE.md`).

## 1. Arquitetura de branches (nova)

```
base-desenvolvimento (branch raiz do projeto, pmc.branch_trabalho)
  └── motor-v2/<tarefa_id>/integracao          ← branch da TAREFA (worktree próprio)
        ├── motor-v2/<tarefa_id>/<subtask>/a1  ← subtarefa, tentativa 1
        ├── motor-v2/<tarefa_id>/<subtask>/a2  ← tentativa 2 (rework)
        └── ...
```

- **Worktree da tarefa:** `<workspaceRaiz>/worktrees/<tarefa_id>/integracao` — criado no
  START da primeira subtarefa (`ensureTaskIntegration`, idempotente: retomadas reutilizam).
- **Por que `/integracao` no nome?** `motor-v2/<tarefa_id>` puro colidiria com as branches
  de subtarefa (conflito D/F de refs no Git: não dá para ter o ref `X` e o diretório `X/`).
  O sufixo vive dentro do mesmo diretório e continua coberto pela purga `motor-v2/<tarefa_id>/*`.
- **Subtarefas branqueiam da branch da tarefa**, não da base. O worktree da tentativa já
  contém tudo que as subtarefas anteriores integraram.
- **Baseline do gate** passa a ser relativo à branch da tarefa (mais preciso: inclui o
  trabalho já integrado).

### Fluxo de integração

1. Gate verde no worktree da subtarefa → commit técnico → worker conclui.
2. Coordenador mergeia a branch da subtarefa **na branch da tarefa**
   (`integrateIntoTaskBranch`, dentro do worktree da tarefa; o repositório principal não é
   tocado nesta etapa).
3. **Gate de integração** na branch da tarefa após CADA merge (build + `npm run test` com
   exclusão de specs funcionais — decisão 2026-09-04). Dependências reinstaladas só quando
   `node_modules` ausente ou o merge tocou `package.json`/`package-lock.json`.
4. Branch da tarefa publicada no origin a cada merge (durabilidade + visibilidade).
5. Quando TODAS as subtarefas estão integradas e a validação de promoção passa:
   **promoção** — merge `motor-v2/<tarefa_id>/integracao` → base no repositório principal +
   push (`promoteTaskBranch`). Só então: `execution_completed`, deploy e purga.

### Regras de conflito (decisão Alexandre 2026-09-05 07:35)

| Conflito | Quem resolve | Comportamento |
|---|---|---|
| **Subtarefa → branch da tarefa** | O **agente** da subtarefa | Merge abortado (nada parcial); subtarefa volta a `pending` (`workspace_status='integration_conflict'`) com o diagnóstico; a próxima tentativa deriva do tip da branch da tarefa, permitindo resolver o conflito. **2º conflito seguido → bloqueio humano** (`systemic_failure`). |
| **Gate de integração vermelho** | O **agente** da subtarefa | Merge revertido (`reset --hard` ao pré-merge); subtarefa volta a `pending` (`workspace_status='integration_reverted'`) com digest da falha. **2ª falha → bloqueio humano**. |
| **Tarefa → base** (drift externo) | **SEMPRE o Alexandre** | Merge abortado, nada aplicado; tarefa **bloqueada** (`blocked_environment`) com a lista de arquivos em conflito; worktree/branch da tarefa **preservados** (sem purge); sem rebase automático. Notificação proativa adiada — ele vê pelo chat/tela da tarefa. |

### Falha definitiva de tarefa

Com a branch de integração, falha definitiva (`onTaskFailed` não-transiente) **preserva**
worktrees/branches da tarefa para investigação (a branch da tarefa também está no origin).
A purga só acontece na conclusão com sucesso.

## 2. Confirmação de falha via git stash (P1 #3)

Antes: a "confirmação no workspace intocado" re-rodava o mesmo comando **com as alterações
do agente aplicadas** — falha ambiental/baseline era atribuída ao agente e queimava
entregas num gate impossível (caso real: tarefa 760).

Agora (`BaselineConfirmation.ts`, chamado no `phaseVerify` do worker após a 2ª falha
consecutiva, e também em falha de build):

1. `git stash push -u` das alterações do agente no worktree da subtarefa.
2. Re-executa o comando de confirmação.
3. `git stash pop` (sempre; falha no pop → bloqueio ambiental, nunca culpa do agente).

Resultados:

- **Falha SEM as alterações** → `baseline_red`: cria subtarefa de **correção de baseline**
  automática (híbrido opção c — alta confiança: a independência foi *provada* pelo stash;
  mecanismo reaproveita o `createBaselineCorrection` do baseline check).
  - Assinatura de infraestrutura (ECONNREFUSED, command not found, ENOENT de binário...) →
    `environment`: bloqueio direto `blocked_environment`, sem correção automática.
  - Se a própria subtarefa de correção de baseline encontra baseline vermelho →
    `correction_failed` + bloqueio humano (anti-loop: nunca gera correção da correção).
- **Passa SEM as alterações** → a falha depende do código entregue: rejeição normal (rework).
- Evento `baseline_red` registrado em `subtarefas_entregas` (auditoria + carry-over).

## 3. Carry-over de aprendizado entre entregas (P1 #4)

Antes: o único feedback era o output bruto do gate truncado — nas entregas 3-4 da tarefa
760 o agente recebeu **HTML de componente MUI** como "erro", sem a asserção real, e nada
do que a tentativa anterior tinha aprendido.

Agora (`CarryOverPolicy.ts`):

- **`digestGateFailure`**: filtra as linhas acionáveis da falha (FAIL, asserções, erros de
  compilação, resumo do runner) e descarta ruído (markup HTML, duplicatas); fallback para o
  final da saída. Usado no feedback de rework E no histórico persistido.
- **Histórico estruturado**: quando a subtarefa já teve entregas (`deliver_count > 0`), o
  prompt do programador recebe a seção "Histórico de entregas anteriores DESTA subtarefa"
  com os eventos de sinal (`gate_rejected`, `return_for_rework`, `blocked`, `baseline_red`,
  `integration_conflict`, `integration_gate_failed`) — modelo, tipo e motivo digerido.
- **Relato do agente**: o `summary` do JSON de resposta da entrega anterior é capturado e
  incluído no feedback ("Relato do agente na entrega anterior") — o agente diz o que tentou.

Novos valores de `subtarefas_entregas.event_type` (varchar(50), sem migração):
`baseline_red`, `integration_conflict`, `integration_gate_failed`.

## 4. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `src/workspaces/GitWorkspaceManager.ts` | `ensureTaskIntegration`, `integrateIntoTaskBranch`, `revertTaskBranchMerge`, `promoteTaskBranch`, `publishBranch`, `taskIntegrationBranch`; purge corrige derivação do diretório da tarefa (worktree `integracao` é 1 nível mais raso). |
| `src/coordinator/TaskCoordinator.ts` | START cria branch da tarefa; subtarefas derivam dela; integração com gate pós-merge + requeue/revert; promoção na conclusão com conflito → bloqueio humano; falha definitiva preserva artefatos. |
| `src/workers/TaskWorker.ts` | Confirmação via stash no `phaseVerify` (build e teste), correção híbrida, anti-loop; carry-over no prompt; digest no feedback/histórico; captura do relato do agente. |
| `src/policies/BaselineConfirmation.ts` | **novo** — confirmação stash + classificação environment/baseline_red. |
| `src/policies/CarryOverPolicy.ts` | **novo** — digest de falha de gate + formatação do histórico. |
| `src/scripts/recover.ts` | `integrate` manual passa a integrar na branch da tarefa (nunca direto na base). |
| `schema.ts` | Comentários/labels de `event_type` (sem migração). |
| `test/TaskIntegrationBranch.test.ts`, `test/TaskBranchFlow.test.ts`, `test/BaselineConfirmation.test.ts`, `test/CarryOverPolicy.test.ts` | **novos** — 396 testes no total, todos verdes. |

## 5. Migração / compatibilidade

- **Tarefas em andamento no deploy:** subtarefas já mergeadas na base pelo fluxo antigo
  continuam lá; a branch da tarefa é criada do tip da base na próxima subtarefa e portanto
  já contém esse trabalho. Sem perda.
- **Recuperação:** `recover.js integrate --subtarefa <id>` reanexa/cria a branch da tarefa
  (`ensureTaskIntegration` é idempotente) e mergeia nela; conflito aborta com mensagem clara.
- O método antigo `integrate()` (merge direto na base) permanece no GitWorkspaceManager
  apenas para compatibilidade de ferramenta externa; o fluxo do motor não o usa mais.
