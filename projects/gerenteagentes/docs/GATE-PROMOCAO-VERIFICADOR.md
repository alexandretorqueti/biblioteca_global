# Gate de Promoção — Verificador e Recuperação Automática

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
  (tabelas/colunas) e migrations **introduzidas pela branch** (não bloqueia por
  dívida histórica da base).
- `PromotionRecoveryPlanner` + `CorrectionSubtaskStore` — planeja e grava a
  subtarefa corretiva idempotente (`correction_for_subtask_id`, `correction_fingerprint`).
- `PromotionConflictAnalyzer/Resolver/Orchestrator` — analisa o conflito real e
  propõe a resolução via Monitor. Label de sessão é **por tentativa** (sufixo do
  worktree), evitando colisão de label no Console em retries.

## Seleção de candidato (estado atual do código)

`PromotionGateRecoveryOrchestrator.nextCandidate()`:

```sql
SELECT t.external_id, pmc.repo_path,
       COALESCE(NULLIF(pmc.branch_trabalho, ''), 'base-desenvolvimento') AS base_branch
FROM tarefas t
INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
WHERE t.status = 'blocked'
  AND pmc.repo_path IS NOT NULL AND pmc.repo_path != ''
  AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified','superseded'))
  AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL
        AND (b.block_command LIKE 'motor-v2:promotion-conflict:%' OR b.block_command LIKE 'motor-v2:promotion-repo-dirty:%'))
ORDER BY t.updated_at ASC LIMIT 1
```

Branch verificada: `motor-v2/<external_id>/integracao`.

## ⚠️ Divergência descoberta (2026-09-11) — hoje o verificador não pesca NINGUÉM

1. **`tarefas` não tem coluna `status`** no banco real do motor (`projeto_640`).
   O status operacional é **derivado** (`TaskFactsStore.derive()` →
   `deriveTaskStatus()`, a partir de `task_runtime_facts`, `subtarefas` e
   `bloqueios`) — ver `motor-v2/src/policies/DerivedTaskStatus.ts`.
   A query usa `t.status = 'blocked'` → falha imediata:

   ```
   ER_BAD_FIELD_ERROR: Unknown column 't.status' in 'where clause'
   ```

   O erro é engolido pelo `try/catch` do `reconcile()` (loga "Falha ao
   reconciliar gate de promoção" e segue). Consequência: **nenhum candidato é
   selecionado e o gate de promoção nunca dispara**.

2. **Prefixo dos bloqueios divergente.** O filtro `NOT EXISTS` espera
   `motor-v2:promotion-conflict:%` / `motor-v2:promotion-repo-dirty:`, mas o
   motor grava outros prefixos:
   - `motor-v2:conflito no merge da branch da tarefa ... — resolução humana necessária ...`
   - `motor-v2:repositório principal não está limpo: ...`

   Mesmo corrigindo (1), o filtro **não exclui** os bloqueios reais de promoção.

## Candidatos na ordem do verificador (`updated_at ASC`), situação 2026-09-11

`elegível` = tem `repo_path` + tem subtarefas + todas `verified`/`superseded` + sem bloqueio nos prefixos novos.

| tarefa | external_id | subtarefas | abertas | elegível |
|---|---|---|---|---|
| #757 | taqui-quick-actions-20260903-05 | 4 | 1 | não |
| #759 | task-biblioteca-759 | 0 | 0 | não |
| **#784** | **task-gerenteagentes-chat-resposta-20260908** | 6 | 0 | **sim (1º)** |
| #793 | task-gerenteagentes-analyst-natural-chat-20260908 | 10 | 0 | sim |
| #780 | task-p2-780 | 8 | 0 | sim |
| #792 | task-p2-792 | 6 | 0 | sim |
| #807 | task-p2-807 | 0 | 0 | não |
| #796 | (sem external_id) | 8 | 6 | não |
| #797 | (sem external_id) | 5 | 3 | não |

Ou seja: **após corrigir a query**, o primeiro a ser pescado é a **#784**
(`task-gerenteagentes-chat-resposta-20260908`), seguida de #793, #780 e #792.

## Correção proposta

1. Trocar `t.status = 'blocked'` pela **derivação canônica** de status
   (join com `task_runtime_facts` + existência de `bloqueios` ativos), ou usar
   um helper/VIEW que exponha o status derivado.
2. Alinhar o filtro de bloqueios aos prefixos realmente gravados
   (`motor-v2:conflito no merge da branch ...`,
   `motor-v2:repositório principal não está limpo: ...`).
3. Cobrir com teste: candidato bloqueado derivado é selecionado; bloqueio de
   promoção ativo impede nova tentativa.
