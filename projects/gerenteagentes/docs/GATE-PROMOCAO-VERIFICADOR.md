# Gate de Promoção — Verificador, seleção de candidato e plano de correção

> Documento vivo. Última atualização: 2026-09-11.

## O que é

Camada de **autocorreção da promoção** do Motor-v2. Em vez de resolver conflitos
de merge na mão, o motor revisa pendências de promoção no boot/pump e reage:

- `PromotionGateRecoveryOrchestrator` — revisa pendências no boot/pump.
  - Lock global MySQL `motor:promotion-gate-recovery` (`GET_LOCK`) → 1 por vez,
    inclusive entre réplicas.
  - Fluxo: `nextCandidate()` → `verifyCandidate()` (worktree `--detach` +
    `verifyWorkspacePromotionGate`) → se `!ok`, `port.recoverPromotionGate()`.
- `PromotionGateVerifier` / `WorkspacePromotionGate` — verifica **capacidades**
  (tabelas/colunas) e migrations **introduzidas pela branch**.
- `PromotionRecoveryPlanner` + `CorrectionSubtaskStore` — planeja/grava a
  subtarefa corretiva idempotente.
- `PromotionConflictAnalyzer/Resolver/Orchestrator` — analisa o conflito real e
  propõe a resolução via Monitor (label de sessão **por tentativa**).

## Seleção de candidato (estado atual — QUEBRADA)

`PromotionGateRecoveryOrchestrator.nextCandidate()`:

```sql
... WHERE t.status = 'blocked' ...
  AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL
        AND (b.block_command LIKE 'motor-v2:promotion-conflict:%' OR b.block_command LIKE 'motor-v2:promotion-repo-dirty:%'))
ORDER BY t.updated_at ASC LIMIT 1
```

Branch verificada: `motor-v2/<external_id>/integracao`.

## ⚠️ Duplamente errado (descoberto 2026-09-11)

### 1. Filtro por `t.status` — coluna inexistente + modelo errado

A tabela `tarefas` do banco real do motor (**schema `projeto_640`**) **não tem
coluna `status`**. O status é **derivado** (`TaskFactsStore.derive()` →
`deriveTaskStatus()`, ver `motor-v2/src/policies/DerivedTaskStatus.ts`), a partir
de `task_runtime_facts`, `subtarefas`, `bloqueios`, `deploy_requests`,
`tarefa_chats` e `paused_at`. A query falha imediatamente:

```
ER_BAD_FIELD_ERROR: Unknown column 't.status' in 'where clause'
```

O erro é engolido pelo `try/catch` do `reconcile()` → **nenhum candidato é
selecionado; o gate nunca dispara**. Além disso, mesmo que a coluna existisse, a
seleção seria **semanticamente errada**, porque o valor materializado (quando
existe, em schemas legados) não reflete o estado operacional real.

### 2. Filtro de bloqueio por LIKE ad-hoc, divergente dos formatos reais

O `NOT EXISTS` só reconhece `block_command LIKE 'motor-v2:promotion-conflict:%'`
e `'motor-v2:promotion-repo-dirty:%'`. Na prática existem **três gerações** de
registro, tratadas de forma diferente por cada componente:

| origem | formato | quem reconhece |
|---|---|---|
| conflito estruturado (atual) | `block_command = motor-v2:promotion-conflict:<base>:<branch>:<fp>` | Orchestrator, PromotionConflictDetector/Repository |
| repo sujo (atual) | `block_command = motor-v2:promotion-repo-dirty:<base>:<branch>:<n>` | Orchestrator, PromotionRetryDetector/Repository |
| conflito legado | `block_command = motor-v2:conflito no merge da branch da tarefa para a base ...` (texto) | só `PromotionConflictRepository` (via `block_excerpt LIKE 'Conflito no merge da branch da tarefa para a base%'`) |
| repo sujo legado | `block_excerpt LIKE 'Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção:%'` | só `PromotionRetryRepository` (via `block_excerpt`) |

Resultado: o Orchestrator **não** exclui os bloqueios legados → risco de
duplo tratamento (gate + fluxo de conflito/retry) depois de corrigir (1).

### 3. Consequência prática (dados reais, 2026-09-11)

Selecionando por **derivação canônica** e considerando `projeto_id` válido em
`projeto_motor_config`:

| tarefa | external_id | subs | integration_confirmed | deploy | derivado | candidata |
|---|---|---|---|---|---|---|
| #793 | task-gerenteagentes-analyst-natural-chat-20260908 | 10 | não | — | **blocked** | **sim (1ª)** |
| #780 | task-p2-780 | 8 | não | — | **blocked** | sim |
| #792 | task-p2-792 | 6 | não | — | **blocked** | sim |
| #784 | task-gerenteagentes-chat-resposta-20260908 | 6 | **sim** | **succeeded** | **deployed** | não (bloqueio obsoleto) |
| #757 | taqui-quick-actions-20260903-05 | 4 (1 aberta) | — | — | (aberta) | não |
| #759 / #807 | — | 0 | — | — | ready/outro | não |
| #796 / #797 | (sem external_id) | 8 / 5 | — | — | (subs abertas) | não |

Ou seja: um filtro por `t.status` **escolheria a tarefa errada** — a #784 já foi
integrada e deployada; seu bloqueio ficou obsoleto (higiene a tratar). As
candidatas legítimas são **#793 → #780 → #792**.

### 4. Sem teste do orquestrador

Não existe `test/PromotionGateRecoveryOrchestrator.test.ts`. Os testes de
verificador cobrem só `PromotionGateVerifier` (puro). Por isso a query só era
exercitada no runtime real.

---

## Plano de correção

**Princípio:** fonte única. Toda decisão de "está bloqueada?" e "é bloqueio de
promoção?" deve sair de código canônico reutilizado — nunca de SQL ad-hoc que
duplica a regra.

### E1 — Seleção de candidato por fatos derivados
- SQL coarse usando **apenas colunas existentes**:
  `INNER JOIN projeto_motor_config`; `EXISTS subtarefa`; `NOT EXISTS subtarefa
  com status NOT IN ('verified','superseded')`; `EXISTS bloqueio não resolvido`;
  `f.integration_confirmed_at IS NULL`; `f.terminal_status IS NULL`;
  `t.paused_at IS NULL`; `NOT EXISTS deploy_request succeeded`;
  `ORDER BY t.updated_at ASC`.
- **Confirmar** o candidato com `TaskFactsStore.derive(...) === 'blocked'`
  antes de verificar (elimina falsos positivos como a #784).
- Se `derive` ≠ blocked, pular e tentar o próximo (limite de N por ciclo).

### E2 — Reconhecimento unificado do bloqueio de promoção
- Extrair módulo único `promotion-blockers.ts` com:
  - `isPromotionConflictBlocker(command, excerpt)` — cobre estruturado + legado.
  - `isPromotionDirtyBlocker(command, excerpt)` — cobre estruturado + legado.
- Reusar em `PromotionGateRecoveryOrchestrator`, `PromotionRetryRepository` e
  `PromotionConflictRepository` (hoje cada um tem o seu LIKE).
- Aplicar o filtro sobre `block_command` **e** `block_excerpt`.

### E3 — Não silenciar falha de schema
- `reconcile()`: logar erro com stack e, em caso de erro SQL (schema), subir o
  nível de log/métrica — o gate inerte deve ser **visível**, não mudo.
- Opcional: validar no boot que as colunas usadas existem (probe em
  `information_schema`), falhando cedo com mensagem clara.

### E4 — Testes
- Novo `test/PromotionGateRecoveryOrchestrator.test.ts`: seleciona candidato
  derivado `blocked`; ignora tarefa `deployed`; ignora tarefa com subtarefa
  aberta; ignora tarefa com bloqueio de promoção ativo.
- Teste de "guardrail de schema": nenhuma SQL do motor referencia
  `tarefas.status` (grep/asserção) e/ou execução da query real contra schema de
  teste espelhando `projeto_640`.
- Estender os testes de detector para os formatos legados.

### E5 — Deploy e validação ao vivo
- Deploy do `biblioteca-global-api`; conferir log do gate disparando.
- Aceite: a 1ª tarefa pescada é a **#793**, depois #780 e #792.

### Critérios de aceite
- Nenhum SQL do motor referencia `tarefas.status`.
- Gate dispara de fato e pesca #793 (com log e lock `motor:promotion-gate-recovery`).
- `typecheck` + suíte completa verdes; sem regressão em PromotionRetry/PromotionConflict.
- Decisão de "bloqueio de promoção" unificada em um único módulo.

### Riscos
- Passar a pescar tarefas legitimamente conflitadas → mitigado por E2 (evita
  duplo tratamento) e por E1 (confirmação por derivação).
- Higiene pendente: bloqueios **obsoletos** (tarefa integrada/deployada com
  `bloqueios` não resolvidos, ex. #784) — o reconciliador deveria resolvê-los
  quando `integration_confirmed_at` for gravado. Fora do escopo desta correção,
  mas registrar como item seguinte.
