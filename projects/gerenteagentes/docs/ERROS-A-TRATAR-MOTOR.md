# Motor v3 — Lista de Erros e Pendências a Tratar

> Documento **vivo**, curado pela Bibliotecária Global 📚. Consolida os
> defeitos/riscos conhecidos do Motor v3 (e infra adjacente) que precisam ser
> tratados, organizados por categoria e prioridade, com evidências dos
> incidentes reais que os originaram.
>
> **Origem:** criado em 2026-11-19 a pedido do Alexandre — *"crie a lista de
> erros que temos que tratar e salve na documentação… inclua problemas de merge,
> conflitos e também o sistema precisa se recuperar sozinho no caso desse erro
> de teste da baseline."*
>
> **Como manter:** cada item tem ID, prioridade, status, sintoma, causa raiz,
> evidência e ação. Ao tratar um item, atualize o **status** (não apague o
> histórico — marque `FIXED` com commit/data). Novos incidentes → nova linha.
>
> **Docs relacionadas (detalhe/desenho):**
> - `TAXONOMIA-ERROS-MOTOR.md` — princípio *"bloqueio é exceção"* (infra/capacity/work).
> - `BASELINE-TESTES-DIFERENCIAL-E-RECUPERACAO-MONITOR.md` — desenho do baseline diferencial e recuperação.
> - `PROMOTION-CONFLICT-ANALYSIS.md` — recuperação de conflito de promoção.
> - `CONCORRENCIA-E-LOCKS-MOTOR.md` — concorrência e locks.
> - `../motor-v3/docs/INCIDENTE-862-CLAIM-ORFAO-ANALISE.md` — claim órfão de análise.
> - `MELHORIAS-MOTOR-2026-10-29.md` — ciclo de melhorias de out/2026 (várias já FIXED).
> - Memória do agente `bibliotecaglobal`: `MEMORY.md` + `memory/*.md` (incidentes detalhados).

---

## Sumário

| ID | Categoria | Problema | Prioridade | Status |
|----|-----------|----------|:----------:|--------|
| **B1** | Baseline/Testes | **Auto-recuperação de baseline vermelha (flaky/pré-existente)** — hoje vira bloqueio duro | **CRÍTICA** | 🔴 ABERTO (pedido Alexandre) |
| B2 | Baseline/Testes | Gate de testes não serializa runs por workspace → `npm ci` concorrente corrompe `node_modules` | ALTA | 🔴 ABERTO |
| B3 | Baseline/Testes | Dedup de gate por `request_message_id` reusa job contaminado → rebloqueia sem reexecutar | ALTA | 🔴 ABERTO |
| B4 | Baseline/Testes | Teste de UI flaky sob carga (`OperationMapScreen.capacityTabs`) | ALTA | ✅ FIXED `fbd5ec82` (2026-11-19) |
| **M1** | Merge/Conflito | `composeBatch` usa `git cherry` → perde resolução de merge commits | ALTA | 🔴 ABERTO |
| **M2** | Merge/Conflito | Migrations paralelas renumeradas em linhagens distintas → `deploy_member_conflict` | ALTA | 🟡 ENDEREÇADO (primitiva `renumber_migration`, tarefa 1097) |
| M3 | Merge/Conflito | Snapshot Drizzle `prevId` colide entre linhagens paralelas | MÉDIA | 🟡 WORKAROUND (regenerar snapshot) |
| M4 | Merge/Conflito | Linhagem obsoleta: worktree reusado com `baseCommit=HEAD` sem sincronizar base | ALTA | ✅ FIXED `21b4ed00` (2026-11-18) |
| M5 | Merge/Conflito | `IntegrationBaseSyncConflictError` no preflight → bloqueio acionável (merge/renumber é trabalho do Monitor) | MÉDIA | 🟢 TRATADO (bloqueio acionável; verificar fluxo Monitor) |
| **C1** | Fila/Claim | `MessageProcessingClaimReconciler` 300s sem heartbeat → consumidor duplicado → takeover de sessão | **CRÍTICA** | ✅ FIXED `39226f3a` (2026-11-19) |
| C2 | Fila/Claim | Correlação reusada entre gerações → colisão unique em `motor_outbox` → DLQ, subtarefa presa | ALTA | 🔴 ABERTO |
| C3 | Fila/Claim | Restart com sessão DEV viva → boot-recovery roda `npm install` no MESMO worktree (corrida) | MÉDIA | 🔴 ABERTO (risco latente) |
| D1 | Entrega/Workspace | DEV declara `::DONE::` sem commitar → entrega órfã, `workspace_commit_sha` NULL | MÉDIA | 🔴 ABERTO |
| D2 | Entrega/Workspace | Workspace npm novo untracked sem regenerar lockfile → `npm ci` EUSAGE (deadlock) | MÉDIA | 🔴 ABERTO |
| D3 | Entrega/Workspace | `npm ci` concorrente: esbuild `ETXTBSY` / `ENOTEMPTY` / `EEXIST` em symlink | MÉDIA | 🔴 ABERTO |
| P1 | Deploy | SHA de commit transitório (rebase) → `git cherry` "unknown commit" → `deploy_failed` | MÉDIA | 🔴 ABERTO |
| P2 | Deploy | Portas trocam no blue-green (3003↔3004 / 3010↔3011) → UI/monitor aponta p/ container morto | BAIXA | 🔴 ABERTO |
| **E1** | Externo/Modelo | Fallback `gpt-5.6-sol` quebrado: `model_not_found` (conta ChatGPT/Codex) | ALTA | ⛔ EXTERNO (ação Alexandre) |
| E2 | Externo/Modelo | Sessão Console termina `status failed` sem mensagem (falha transitória Gateway/modelo) | MÉDIA | 🔴 ABERTO (diagnóstico) |
| G1 | Lacuna/Código morto | `TASK_CANCEL_REQUESTED` sem consumidor → `{ok:true}` falso | MÉDIA | 🔴 ABERTO |
| G2 | Lacuna/Código morto | Falha de análise não vai para "Atenção" (sem bloqueio/evento/terminal_status) | MÉDIA | 🔴 ABERTO |
| G3 | Lacuna/Código morto | `TASK_PAUSE_REQUESTED` sem consumidor → pausa não interrompe worker em execução | BAIXA | 🔴 ABERTO |

Legenda: 🔴 ABERTO · 🟡 ENDEREÇADO/WORKAROUND · 🟢 TRATADO (verificar) · ✅ FIXED · ⛔ EXTERNO.

---

## 1. Baseline e Testes

### B1 — Auto-recuperação de baseline vermelha 🔴 CRÍTICA (pedido do Alexandre, 2026-11-19)

**Sintoma.** Quando o **baseline** (build+testes no commit-base, ANTES do DEV)
falha, o motor bloqueia a subtarefa com `baseline_preflight_failed` e exige
intervenção externa (Monitor / `external-resolution`). Um único teste flaky na
base — sem relação com a tarefa — derruba o preflight de **todas** as tarefas
até alguém intervir.

**Causa raiz.** O fluxo atual trata "baseline vermelho" como bloqueio duro de
primeira. Não há: (a) detecção automática de flake com re-execução; (b)
classificação diferencial que permita **pré-existente** não bloquear tarefa nova;
(c) recuperação robusta quando a sessão de baseline-fix falha. O desenho desejado
já está em `BASELINE-TESTES-DIFERENCIAL-E-RECUPERACAO-MONITOR.md` (regras 1–10),
mas o caminho de auto-recuperação não está plenamente efetivo.

**Requisito (o sistema precisa se recuperar sozinho).**
1. **Detecção automática de flake:** baseline falhou → re-executar **apenas os
   testes falhos** (ou o baseline completo) até 2–3 vezes ANTES de bloquear. Se
   passar na re-execução → classificar `flaky_or_inconclusive` em
   `test_failures.classification`, tratar o baseline como **VERDE**, liberar o
   DEV e registrar o incidente. **Não bloquear.**
2. **Diferencial pré-existente × novo:** falha cuja assinatura já existe na base
   (`pre_existing`) **não bloqueia** a tarefa nova — libera o DEV e abre missão de
   recuperação separada (Monitor) para o pré-existente (regras 9–10 do doc de
   baseline). Somente falha **nova/piorada** introduzida pela tarefa reprova.
3. **Recuperação de baseline-fix robusta:** se o baseline ficar vermelho de
   verdade, a sessão de recuperação deve (a) usar cadeia de modelos **saudável**
   (não contar com `gpt-5.6-sol` — ver E1); (b) se a sessão terminar `status
   failed` (ver E2) ou sem produzir correção, **re-executar o baseline uma vez**
   (pode ter sido flake) antes de bloquear; (c) nunca morrer por takeover de
   claim (ver C1, já corrigido).
4. **Bloqueio duro = último recurso:** `baseline_preflight_failed` → Monitor só
   depois de esgotadas detecção de flake, classificação diferencial e tentativa
   de recuperação — coerente com o princípio *"bloqueio é exceção"*
   (`TAXONOMIA-ERROS-MOTOR.md`).

**Evidência.** Bloqueios 3500 (s1541) e 3501 (s1544) em 2026-11-19, ambos por
flake do `capacityTabs` (B4) somado à falha da recuperação (E2/C1). `test_runs`
1241/1242 (vermelho flaky) → 1244/1249 (verde após fix). Nota: B4/C1 já
corrigidos removem o *trigger* e a *corrida*; **B1 é a mudança estrutural** que
evita que qualquer flake futuro volte a bloquear tarefas.

**Ação.** Implementar re-execução de flake + classificação diferencial no
`TestGateOrchestrator`/`SubtaskExecutionConsumer` (fase `baseline_preflight`) e
endurecer o `BaselinePreflightRecovery`. Cobrir com testes.

---

### B2 — Gate de testes não serializa runs por workspace 🔴 ALTA

**Sintoma.** Dois `test_runs` (ex.: `baseline` e `monitor_recovery`) agendados
**concorrentes no mesmo worktree** → o `npm ci` de um corrompe o `node_modules`
do outro (`ENOTEMPTY`, dependências incompletas → `[UNLOADABLE_DEPENDENCY]`).

**Causa raiz.** O orquestrador do gate não serializa execuções por
`workspace_path`; jobs de fases distintas podem rodar em paralelo sobre o mesmo
checkout.

**Evidência.** task-p1-1007/1375, bloqueios 3357–3359 (2026-10-14): runs 765
(baseline) e 766 (monitor_recovery) 22:58–22:59 no mesmo worktree.

**Ação.** Lock/serialização por `workspace_path` no agendamento de `test_runs`
(um run por worktree por vez), ou worktree isolado por fase. Logs detalhados em
`test_runs.stdout/stderr_artifact_path`.

---

### B3 — Dedup de gate reusa job contaminado 🔴 ALTA

**Sintoma.** Reentrega de mensagem de gate **não reexecuta** os testes: reusa um
job `completed` anterior (contaminado por colisão de `npm ci`) e **rebloqueia**
em ~70s.

**Causa raiz.** `TestGateOrchestrator` deduplica por
`request_message_id=${messageId}:${phase}:${subtaskId}` (INSERT IGNORE). Se o
job anterior fechou contaminado, a reentrega reaproveita o resultado ruim.

**Evidência.** task-p1-1007/1375, bloqueio 3359 (2026-10-14).

**Ação.** Invalidar/renovar a chave de dedup quando o job anterior é classificado
`flaky_or_inconclusive`/`test-setup` (ex.: sufixar `-inv-<ref>`), ou não dedupar
sobre resultado não-confiável. Garantir que reentrega reexecute o gate.

---

### B4 — Teste de UI flaky sob carga (`capacityTabs`) ✅ FIXED

**Sintoma.** `OperationMapScreen.capacityTabs › "mantém a aba Chat ao clicar em
outra tarefa"` falhava **somente** sob carga do suite completo no gate (48
workers): o `fireEvent.click` único da troca de tarefa perdia o efeito e o
`detail-content` ficava na tarefa anterior até estourar o timeout.

**Causa raiz.** Componente pesado + CPU saturada → re-render da troca de seleção
não cometia na janela; **não** é bug de produto (isolado passa em ~400ms).

**Correção (FIXED).** `fbd5ec82` (2026-11-19, base-desenvolvimento): helper
`selecionarTarefa()` reemite o clique dentro do `waitFor` até refletir a tarefa
(`openTask` é idempotente → converge sem mascarar regressão). Validação: suite
completo 3× 1537/1537; validado também na baseline da s1544 (run 1249).

**Evidência.** runs 1104/1232/1241/1242 (`test_failures` classificados
`flaky_or_inconclusive`); bloqueios 3469/3500/3501.

**Ação residual.** Manter em observação; B1 torna o sistema resiliente a flakes
futuros mesmo sem fix específico de cada teste.

---

## 2. Merge e Conflitos

### M1 — `composeBatch` usa `git cherry` e perde resolução de merge 🔴 ALTA

**Sintoma.** Deploy de batch com membro cuja linhagem tem **merge commit de
sincronização** (base mergeada na integração, com conflitos resolvidos) tenta
**reaplicar a versão paralela antiga** e conflita de novo.

**Causa raiz.** `composeBatch` usa `git cherry`, que **omite merge commits** —
portanto as resoluções de conflito feitas no merge não são preservadas na
composição do batch.

**Evidência.** isas-mt-08/1497, bloqueio 3489 (2026-11-18): pedido 410 congelou
`e51a64f1` (linhagem com merge `ee5cec3a`); `git cherry` perdeu resoluções de
`app.module.ts`/`schema.ts`/`_journal.json`.

**Ação.** Normalizar/squashar o delta da tarefa sobre a base corrente antes do
deploy (commit único sobre a base), ou fazer o compositor preservar resoluções de
merge (não depender só de `git cherry`).

---

### M2 — Migrations paralelas renumeradas em linhagens distintas 🟡 ENDEREÇADO

**Sintoma.** `deploy_member_conflict`: dois membros de um batch ocupam a **mesma**
numeração de migration (`0015`), ou o compositor reaplica versão antiga
renumerada diferente da integração → conflito em `*_snapshot.json`,
`_journal.json` e `packages/shared/src/index.ts`.

**Causa raiz.** Cada tarefa gera migrations em linhagem paralela sem um
"de-para" determinístico de numeração ao convergir para a base.

**Evidência.** isas-mt-09 (bloqueio 3493), isas-mt-08 (3489), isas-mt-01
(3477/3479/3481/3484/3485) — 2026-11.

**Ação (em andamento).** Primitiva **`renumber_migration`** + seeds do de-para de
conflitos no catálogo — **tarefa motor-frente-c-seeds-renumber (1097)**,
subtarefa 1541 `verified` (2026-11-19). Confirmar promoção/deploy e efetividade
nos próximos batches. Ver também `PROMOTION-CONFLICT-ANALYSIS.md` e
`DRY-RUN-MIGRATIONS-SCRATCH.md`.

---

### M3 — Snapshot Drizzle `prevId` colide entre linhagens 🟡 WORKAROUND

**Sintoma.** `drizzle-kit generate` falha: *"pointing to a parent snapshot …
collision"* — snapshots gerados em linhagens paralelas colidem por `prevId`.

**Causa raiz.** `prevId` do snapshot aponta para o anterior da linhagem; ao
renumerar/convergir, dois snapshots reivindicam o mesmo encadeamento.

**Evidência.** isas-mt-08/1497, bloqueio 3488 (2026-11-18): snapshot `0012` com
`prevId` colidido com `0011`.

**Ação.** **Regenerar o snapshot** (nunca o SQL já aplicado) ao normalizar a
linhagem; a primitiva `renumber_migration` (M2) deve tratar o reencadeamento de
`prevId`/`_journal` de forma determinística.

---

### M4 — Linhagem obsoleta: worktree reusado com `baseCommit=HEAD` ✅ FIXED

**Sintoma.** `worker_exhausted` + "sem diff": a integração e o worktree do DEV
seguem presos num commit antigo SEM contratos que a base já tem → pré-condição do
escopo impossível → DEV "não altera o worktree".

**Causa raiz.** `GitWorktreePreparer` reutiliza o worktree com `baseCommit=HEAD`
e `syncIntegrationBranch` só era chamado pelo `DeployConsumer` — a linhagem não
era sincronizada com a base promovida antes do baseline/DEV.

**Correção (FIXED).** `21b4ed00` (2026-11-18): `prepareIntegration({subtaskId})`
sincroniza a linhagem ANTES do baseline (fetch + merge na integração + ff do
worktree), com guardas e `IntegrationBaseSyncConflictError` → bloqueio de
preflight acionável (ver M5). Primitiva `sync_task_lineage`.

**Evidência.** isas-mt-08/1497, bloqueio 3488 (2026-11-18).

---

### M5 — Conflito ao trazer a base para a integração no preflight 🟢 TRATADO

**Sintoma.** Merge da base promovida na integração conflita (arquivos de schema,
migrations, módulos).

**Tratamento atual.** `IntegrationBaseSyncConflictError` → bloqueio de preflight
**acionável** (merge/rebase + renumeração de migrations é trabalho do Monitor),
em vez de queimar tentativas de DEV até `worker_exhausted`.

**Ação.** Verificar se o fluxo do Monitor (`PromotionConflictOrchestrator` /
`PROMOTION-CONFLICT-ANALYSIS.md`) resolve esses bloqueios de ponta a ponta sem
intervenção manual; integrar com M2/M3 (renumber determinístico).

---

## 3. Fila, Claim e Concorrência

### C1 — ClaimReconciler 300s sem heartbeat → takeover de sessão ✅ FIXED (CRÍTICA)

**Sintoma.** Sessões de trabalho longas (baseline-fix, DEV) morrem com
`EmbeddedAttemptSessionTakeoverError`; às vezes a sessão é morta **depois** de
deixar o gate verde.

**Causa raiz.** `MessageProcessingClaimReconciler` (`src/queue/`) usa
`processingTimeoutSeconds=300` **fixo**, sem verificar se o consumidor está
**VIVO**. Etapa que roda >300s (ex.: baseline ~9min, recuperação Console ~6min)
tem a mensagem `SUBTASK_EXECUTION_REQUESTED` **re-enfileirada** → consumidor
**duplicado** reenvia o prompt à **mesma sessão** (chave estável) → o gateway
mata o run ativo por takeover.

**Correção (FIXED).** `39226f3a` (2026-11-19): **heartbeat do claim** no
`QueueConsumer` — `timeout_at` renovando (~60s) nos claims `processing`, então o
reconciliador não re-enfileira consumidor vivo. Confirmado em produção
(biblioteca-blue-api-1, restart 18:07Z, healthy). Protege sessões DEV longas.

**Evidência.** s1541 (sessão qwen morta 8s após gate verde 26/26), s1544;
duplicatas rejeitadas com `development_session_recovery_owned` em 17:59/18:01;
bloqueios 3500/3501/3502. Ver também `../motor-v3/docs/INCIDENTE-862-CLAIM-ORFAO-ANALISE.md`.

**Ação residual.** Observar em produção; garantir que o heartbeat cubra todas as
etapas longas (baseline, DEV, recuperação, deploy).

---

### C2 — Correlação reusada entre gerações → colisão em `motor_outbox` 🔴 ALTA

**Sintoma.** Subtarefa fica `pending` **sem bloqueio**; mensagem cai na DLQ por
`ER_DUP_ENTRY` no unique index `(type, task_id, correlation_id)` do
`motor_outbox`.

**Causa raiz.** Re-dispatch (ex.: capacity scheduler) reutiliza **correlação
antiga** de geração anterior; `TaskUnblockedConsumer`/`enqueueReady` só evita
duplicata de correlação quando não há mensagem da **geração corrente** — entre
gerações a correlação stale colide.

**Evidência.** isas-mt-02/1503, bloqueio 3487 (2026-11-18): DLQ com
`ER_DUP_ENTRY … 'TASK_READY_FOR_PROGRAMMING-task-p2-1002-a8d07205'`.

**Ação.** Renovar o `correlation_id` a cada geração/claim novo (não reaproveitar
entre gerações), ou tornar o índice tolerante a re-dispatch legítimo. Auditar
todos os emissores de `TASK_READY_FOR_PROGRAMMING`.

---

### C3 — Restart com sessão DEV viva → boot-recovery no mesmo worktree 🔴 MÉDIA (risco latente)

**Sintoma.** Restart do motor enquanto uma sessão DEV está ativa no Gateway: o
boot-recovery "adota" a sessão e roda `npm install`/gate no **mesmo worktree** em
que a sessão gateway pode estar trabalhando → risco de `ETXTBSY`/`ENOTEMPTY`/gate
inconclusivo.

**Causa raiz.** Recovery de sessão de desenvolvimento e a sessão gateway viva
compartilham o worktree da subtarefa sem coordenação exclusiva de filesystem.

**Evidência.** s1541 (2026-11-19): npm install no worktree `1541/a1` às 18:09Z
durante recuperação pós-restart. **Não causou dano** desta vez (2380 completou,
s1541 verified), mas é risco real (lição de 2026-11-18, D3).

**Ação.** Coordenar exclusividade de worktree entre recovery e sessão gateway
viva (lock por worktree, ou recuperar só após confirmar que a sessão gateway
encerrou), ou isolar worktree do gate de recuperação.

---

## 4. Entrega e Workspace

### D1 — DEV declara `::DONE::` sem commitar → entrega órfã 🔴 MÉDIA

**Sintoma.** `development_failed` com `workspace_commit_sha` NULL; o gate de
rework roda sobre o commit **inalterado**; mudanças ficam uncommitted no worktree.

**Causa raiz.** O protocolo de conclusão aceita `::DONE::` sem garantir que o
trabalho foi **commitado** na branch do DEV.

**Evidência.** billing-fix-e2e-2026-11/1537, bloqueio 3499 (2026-11-19): sessão
luna editou doc e declarou `::DONE::` sem commit → entrega órfã em `1537/a1`.

**Ação.** Validar `git status`/commit antes de aceitar conclusão; se houver
mudanças uncommitted, commitá-las automaticamente (ou rejeitar `::DONE::` com
instrução explícita). Ver também resgate em `memory/2026-11-19-billing-fix-e2e-*`.

---

### D2 — Workspace npm novo untracked sem lockfile → `npm ci` EUSAGE 🔴 MÉDIA

**Sintoma.** `npm ci` falha (EUSAGE) nas 3 tentativas → deadlock; subtarefa presa.

**Causa raiz.** Sessão DEV cria workspace npm novo **untracked** sem regenerar o
lockfile; `ensureCleanWorkspace` reverte lockfile **tracked** sujo mas não remove
untracked → estado inconsistente para `npm ci`.

**Evidência.** isas-mt-02/1503, bloqueio 3487 (2026-11-18).

**Ação.** Ao preparar o ambiente, garantir lockfile coerente (`npm install
--package-lock-only` quando há workspace novo) ou tratar untracked no
`ensureCleanWorkspace`.

---

### D3 — `npm ci` concorrente: esbuild `ETXTBSY` / `ENOTEMPTY` / `EEXIST` 🔴 MÉDIA

**Sintoma.** `npm ci` falha com `esbuild ETXTBSY` (postinstall) + vários
`ENOTEMPTY` no cleanup, ou `EEXIST` ao recriar symlink de workspace
(`node_modules/@biblioteca-global/web`).

**Causa raiz.** Instalações **concorrentes**/reuso do mesmo `node_modules` entre
runs (ver B2, C3). Não é regressão de código.

**Evidência.** motor-fix-artefatos/1520, bloqueio 3498; billing-sandbox-runbook/1521,
bloqueio 3497 (2026-11-18).

**Ação.** Eliminar concorrência de instalação por worktree (B2/C3); repetir
instalação sem concorrência antes de classificar como falha; preservar delta
antes de descartar worktree.

---

## 5. Deploy

### P1 — SHA de commit transitório (rebase) → `git cherry` "unknown commit" 🔴 MÉDIA

**Sintoma.** `deploy_failed`: compositor não encontra o commit congelado no
pedido ("unknown commit").

**Causa raiz.** Pedido de deploy congela um SHA que depois é **rebaseado/
substituído** na linhagem; `git cherry` não o reconhece mais.

**Evidência.** isas-mt-04, bloqueio 3486 (2026-11-18).

**Ação.** `refreshStaleRequestedCommit` (já existente) deve cobrir todos os
caminhos de deploy; revalidar pedido contra o HEAD atual da integração antes de
compor (ver `StaleRequestedCommitRefresh.ts`).

---

### P2 — Portas trocam no blue-green 🔴 BAIXA

**Sintoma.** UI/monitor aponta para porta de container **morto** → toggles que
"não funcionam", chamadas falham.

**Causa raiz.** Portas alternam no swap blue-green (API 3003↔3004, motor
3010↔3011).

**Evidência.** `MELHORIAS-MOTOR-2026-10-29.md` (descobertas do dia).

**Ação.** Resolver a porta ativa via docker socket (`Ports`) antes de chamar, ou
publicar porta estável via proxy. Documentar no runbook de deploy.

---

## 6. Externo / Modelo

### E1 — Fallback `gpt-5.6-sol` quebrado ⛔ EXTERNO (ação Alexandre)

**Sintoma.** `model_not_found`: *"not supported when using Codex with a ChatGPT
account"* — o fallback de todas as cadeias morre em <1s.

**Causa raiz.** Configuração/conta: o modelo `gpt-5.6-sol` não está disponível
na conta ChatGPT/Codex em uso. **Fora do controle do código do motor.**

**Evidência.** Reportado pela sessão monitora b3501/s1544 (2026-11-19);
`motor_agent_session_failures`.

**Ação (Alexandre).** Corrigir credencial/conta ou **remover `gpt-5.6-sol` das
cadeias de fallback** até estar disponível. Enquanto isso, o motor **não deve
contar** com esse fallback (afeta B1.3, C1, recuperação de baseline/DEV).

---

### E2 — Sessão Console `status failed` sem mensagem 🔴 MÉDIA (diagnóstico)

**Sintoma.** Sessões (baseline-fix, DEV) terminam com `status failed` no Gateway
**sem gerar mensagem** — o motor só vê "Sessão do Console terminou com status
failed".

**Causa raiz.** Falha transitória de Gateway/provedor/modelo; às vezes combinada
com takeover (C1) ou fallback quebrado (E1). Diagnóstico pobre: sem detalhe do
provedor no histórico.

**Evidência.** s1541 baseline-fix qwen3.8-max (2367) e gpt-5.6-sol (2370);
billing/baseline incidentes 2026-11.

**Ação.** Melhorar captura de erro do provedor no `ConsoleHttpApi`
(`failureText`/`errorCode`/`stopReason`); distinguir "falha transitória de
Gateway" (retry sem consumir tentativa) de "falha real"; integrar com taxonomia
(capacity → backoff, não bloqueio).

---

## 7. Lacunas / Código morto (auditoria incidente 862)

> Itens documentados em `../motor-v3/docs/INCIDENTE-862-CLAIM-ORFAO-ANALISE.md`
> como "NÃO corrigidos no ciclo — apenas documentados". Revalidar se seguem
> abertos.

### G1 — `TASK_CANCEL_REQUESTED` sem consumidor 🔴 MÉDIA

Cancel enfileira comando que nenhum consumer trata; `QueueConsumer` marca
"completed" e a API responde `{ok:true}` — **sucesso falso**. A Biblioteca grava
`cancelled` confiando nesse ok (trilha inconsistente com os fatos). **Ação:**
implementar consumidor de cancel (parar worker, gravar `terminal_status`, emitir
evento) ou retornar erro explícito.

### G2 — Falha de análise não vai para "Atenção" 🔴 MÉDIA

O catch do coordenador faz `releaseAnalysisClaim` + `bus.emit('ANALYSIS_FAILED')`
+ rethrow (DLQ), mas: nenhum subscritor para `ANALYSIS_FAILED`; motor-v3 nunca
escreve `terminal_status='failed'`; nenhum `INSERT INTO bloqueios`; nenhum evento
E33_TASK_BLOCKED; nada em `tarefa_eventos`. A tarefa volta silenciosa a `planned`
ou congela órfã **sem aparecer na estação Atenção**. **Ação:** propagar falha de
análise para bloqueio/evento visível.

### G3 — `TASK_PAUSE_REQUESTED` sem consumidor 🔴 BAIXA

A pausa "funciona" porque a Biblioteca grava `paused_at` direto no banco, mas
**nenhum worker em execução é parado**. **Ação:** implementar consumidor de pausa
que interrompa/suspenda worker ativo com segurança (checkpoint).

---

## Histórico de atualizações

- **2026-11-19** — Criação (Alexandre). Consolida incidentes de out–nov/2026 da
  memória do agente + coordenação dos monitores b3500/s1541 e b3501/s1544.
  Marcação: B4 FIXED `fbd5ec82`; C1 FIXED `39226f3a`; M4 FIXED `21b4ed00`;
  M2 ENDEREÇADO (tarefa 1097 verified); E1 EXTERNO. Destaque para **B1**
  (auto-recuperação de baseline) como pedido explícito do Alexandre.
