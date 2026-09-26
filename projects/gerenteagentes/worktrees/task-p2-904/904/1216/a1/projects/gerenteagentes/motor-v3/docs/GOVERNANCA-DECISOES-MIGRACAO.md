# Governança de Decisões do Motor v3 — Migração do Hardcoded para o Catálogo

> Data: 2026-09-22 · Autor: Gerente de Agentes (a pedido do Alexandre)
> Status: **PROPOSTA / ROADMAP** — nenhum código alterado ainda.
> Contexto: discussão sobre transformar as decisões hardcoded do motor em dados
> gerenciáveis (tela + banco), mantendo primitivas como código.

---

## 1. Objetivo

Hoje, quando algo falha no motor, o comportamento ("tentar de novo", "trocar de
modelo", "bloquear e mandar para Atenção") está escrito em código (if/else).
O objetivo é migrar essas decisões **aos poucos** para o catálogo governável que
já existe no banco, de modo que:

- **Decisões** (se erro X → ação Y, com escalonamento por ocorrência) sejam
  dados editáveis e auditáveis;
- **Ações** sejam sequências ordenadas de primitivas definidas em
  `motor_actions.primitives_json`;
- **Código** se reduza a desenvolver **primitivas** novas (operações atômicas);
- Uma **tela** permita incluir/excluir/alterar lógicas com validação e simulação.

---

## 2. Estado atual — o que JÁ existe

### 2.1 Tabelas do catálogo (motor-v3, `src/db/schema.ts` + migrations)

| Tabela | Papel | Estado em produção (2026-09-22) |
|---|---|---|
| `motor_events` | Catálogo de eventos (categoria: erro/verificacao/conclusao/estado/humano/infra; escopo; prioridade) | **35 eventos ativos** (E01–E35) |
| `motor_patterns` | Detecção de erro → evento. `match_type`: `regex`/`contains`/`exact`; `match_target`: `code`/`message`/`stack`/`action_result` | **18 padrões ativos**, cobrindo E01–E10 |
| `motor_reactions` | Cadeia progressiva: ocorrência 1 → ação A, 2 → ação B, 3+ → ação C. Tem `params_json` | **21 reações ativas** (E01–E10) |
| `motor_actions` | `primitives_json` = sequência ordenada de primitivas; `on_partial_failure` (continue/compensate/mark_dirty); `compensation_action_id`; `is_terminal` | **26 ações ativas** |
| `motor_primitives` | Referência das primitivas (registro real em código: `src/primitives/`) | ~30 primitivas (session, model, git, db, queue, control) |
| `motor_occurrences` | Contagem por (evento, tarefa, subtarefa, geração) — alimenta a cadeia de reações | **0 registros** ⚠️ |
| `motor_catalog_proposals` | Propostas de alteração do catálogo (fonte: monitor/humano; status: auto_activated/pending_review/approved/rejected) | **0 registros** ⚠️ |
| `motor_event_log` | Log estruturado de eventos (observabilidade) | em uso |
| `motor_promotion_state` | Dirty flag de promoção (B20) | em uso |
| `motor_model_cooldown` | Cooldown de modelos | em uso |
| `motor_commands` / `motor_command_policies` / `motor_operation_log` | Governança de comandos (C01–C04, P01–P04) e trilha de auditoria | em uso (cancel/resume governados) |

### 2.2 Componentes de código do pipeline (implementados e testados)

```
Erro bruto {code, message, stack, actionResult}
   │
   ▼
EventClassifier.classify()          ← src/classifier/EventClassifier.ts
   │ testa motor_patterns por prioridade do evento
   │ incrementa motor_occurrences atomicamente
   │ busca motor_reactions pela contagem de ocorrência
   ▼
CatalogAction (motor_actions)
   │
   ▼
ActionExecutor.executeAction()      ← src/executor/ActionExecutor.ts
   │ roda primitives_json em ordem
   │ trata on_partial_failure + compensation_action_id
   ▼
Primitivas registradas               ← src/primitives/ (index.ts registerAllPrimitives)
```

### 2.3 Tela existente

`projects/gerenteagentes/screens/MotorV3TablesScreen.tsx` — tela **"Motor v3"**
(Regras e Observabilidade), **somente leitura**, combo agrupado:

- **Catálogo de regras:** Eventos, Padrões, Primitivas, Ações, Reações
- **Estado operacional:** Ocorrências, Estado de promoção, Cooldown de modelos
- **Observabilidade:** Propostas do catálogo, Log de eventos
- **Saúde de testes:** Execuções de testes, Falhas normalizadas, Recuperações do Monitor

Endpoint: `GET /gerenteagentes/motor-v3/tabelas/:tabela` (até 200 registros).

### 2.4 ⚠️ Descoberta central

**O pipeline está construído, mas NÃO está conectado ao fluxo real.**

Evidências (verificação em código + banco de produção, 2026-09-22):

1. `EventClassifier.classify()` tem **um único chamador**: `MonitorBridge.handleUncataloguedError()`.
2. `MonitorBridge.handleUncataloguedError()` **nunca é chamado** por nenhum
   consumidor; o `start.ts` só usa o MonitorBridge para listar/aprovar/rejeitar
   propostas via HTTP. E o `invokeMonitor()` interno é **TODO** (sem LLM real).
3. `ActionExecutor.executeAction()` **não tem chamadores** fora dos testes — o
   `start.ts` instancia o executor e registra as primitivas, mas o fluxo de
   produção não o invoca (só expõe `getRegisteredPrimitives()` via HTTP).
4. `motor_occurrences` = **0 registros** e `motor_catalog_proposals` = **0** → o
   classificador nunca processou um erro real em produção.

Ou seja: o catálogo é hoje uma **biblioteca de intenções** (bem desenhada), e as
decisões reais correm 100% em código hardcoded. A migração é majoritariamente um
trabalho de **conexão**, não de construção.

---

## 3. Mapa das decisões hardcoded

Legenda: 🔴 decisão de falha crítica · 🟡 decisão secundária · ✅ já governado.

### 3.1 Análise (coordinator + analysis)

| # | Ponto | Arquivo | Comportamento atual | Nível |
|---|---|---|---|---|
| H1 | Falha de análise na tentativa final | `src/coordinator/TaskCoordinator.ts` (~L216–227) | `attempt >= maxAnalysisAttempts` (default 3, config) → `AnalysisFailureBlocker.blockForAnalysisFailure()` → bloqueio `analysis_failed` → **Atenção**. Tentativas anteriores → exceção → retry do broker | 🔴 |
| H2 | Fallback de modelo (cadeia) | `src/analysis/ConsoleAnalystRunner.ts` (~L100–155) | Loop pelos modelos da cadeia; erro com `isModelUnavailable()` → `modelFailureRecorder` (cooldown) → próximo modelo; esgotou → lança último erro | 🔴 |
| H3 | Resposta inválida do analista (contrato) | `src/analysis/ConsoleAnalystRunner.ts` (~L131–145) | Parse falhou → **uma** mensagem corretiva no mesmo modelo → parse de novo → falhou → próximo modelo da cadeia | 🔴 |
| H4 | Timeout da sessão do analista | `src/analysis/ConsoleAnalystRunner.ts` (`waitForResult`) | Polling até `timeoutMs` → erro → cai no loop de modelos (H2) | 🟡 |
| H5 | Claim órfão de análise | `src/coordinator/TaskCoordinator.ts` + `AnalysisClaimReconciler.ts` | Reentrega com claim vencido → recupera antes do gate de políticas; boot → reconciliador varre órfãos (commit `76fa507`) | ✅ (regra fixa, candidata a primitiva `recover_orphan_claim`) |

### 3.2 Execução / workers (execution + worker-launcher)

| # | Ponto | Arquivo | Comportamento atual | Nível |
|---|---|---|---|---|
| H6 | Esgotamento de tentativas do worker | `src/worker-launcher/WorkerLauncher.ts` (~L73–95) | `attempts >= maxAttempts` (default 3) → "Esgotado número máximo de tentativas" → falha da subtarefa | 🔴 |
| H7 | Ciclo de rework (regressão de gate) | `src/execution/SubtaskExecutionConsumer.ts` | Gate diferencial acusa regressão → nova entrega (rework); `rework >= maxRework` (projeto, default 3) → bloqueia subtarefa ("Limite de entregas atingido") | 🔴 |
| H8 | Falhas preexistentes fora de escopo | `src/execution/SubtaskExecutionConsumer.ts` (~L256) | Lista falhas preexistentes no prompt do rework e instrui a não corrigi-las | 🟡 (prompt, não decisão) |

### 3.3 Testes / gates (testing)

| # | Ponto | Arquivo | Comportamento atual | Nível |
|---|---|---|---|---|
| H9 | Resultado do gate | `src/testing/TestGateService.ts` (~L105–145) | `exitCode ≠ 0` → `failed`; comparação baseline vs run → `regression`/`no_regression`/`inconclusive` | 🟡 (classificação — candidato natural a emitir evento E09/E13) |
| H10 | Baseline vermelho (pré-dev) | `src/testing/BaselinePreflightRecovery.ts` | Baseline falhou → recuperação de ambiente (deps) → roda de novo → ainda vermelho → prompt de recuperação do Monitor (fase `monitor_recovery`) → ainda vermelho → erro/bloqueio | 🔴 |
| H11 | Recuperação do Monitor (testes) | `src/testing/TestRecoveryConsumer.ts` | Consome jobs de recuperação, roda fase `monitor_recovery`, compara falhas novas/resolvidas | 🟡 |

### 3.4 Deploy (deploy)

| # | Ponto | Arquivo | Comportamento atual | Nível |
|---|---|---|---|---|
| H12 | Falha no dispatch do batch | `src/deploy/DeployConsumer.ts` (~L86, L130, L213) | `completeBatch(false)` + `blockTask(taskId, 'deploy_failed', detalhe)` → **Atenção** (incidente 863/864: NaN e git 128 caíram aqui) | 🔴 |
| H13 | Gate pre_deploy falhou | `src/deploy/DeployRepository.ts` (~L183) | `blockTask('pre_deploy_gate_failed')` → Atenção | 🔴 |
| H14 | Script blue-green falhou | `src/deploy/DeployConsumer.ts` (~L109) | `completeBatch(false, 'script blue-green informou falha')` → bloqueio | 🔴 |
| H15 | Conflito/estado sujo de promoção | `motor_promotion_state` (B20) + `promote()` | Dirty flag + tentativas; desbloqueio manual rejeita bloqueios de promoção suja aguardando retentativa | 🟡 |

### 3.5 Fila / infraestrutura (queue)

| # | Ponto | Arquivo | Comportamento atual | Nível |
|---|---|---|---|---|
| H16 | Mensagem inválida | `src/queue/QueueConsumer.ts` (~L48) | → DLQ `invalid-message` | 🟡 |
| H17 | Limite de tentativas da fila | `src/queue/QueueConsumer.ts` (~L51, L94) | `attempt > maxAttempts` → DLQ `max-attempts-exceeded` | 🔴 |
| H18 | Erro inesperado no handler | `src/queue/QueueConsumer.ts` (~L74–80) | nack/requeue; estado inesperado → DLQ | 🟡 |

### 3.6 Já governados (referência de padrão)

| Ponto | Como funciona |
|---|---|
| Cancelamento (C04) | `TaskCancelConsumer`: comando → policy P04 → ação A22; primitivas idempotentes (release claim → resolve bloqueios → mark cancelled → record event); endpoint 202 (commit `17d28ec`) |
| Resume governado | `governed-resume.test.ts` / migration 0063 |
| Auditoria | Todo caminho governado loga em `motor_operation_log` (operationId, phase, outcome, primitiveCode, reasonCode) |

**Obs.:** mesmo os consumidores "governados" usam o catálogo para **decidir
permitir/negar e auditar** (CommandPolicyResolver + OperationLogger), mas a
**execução** das primitivas ainda é código próprio do consumidor — não passa
pelo `ActionExecutor.executeAction()`.

---

## 4. Alterações necessárias

### 4.1 Banco / tabelas

**Nenhuma tabela nova é estritamente necessária.** Ajustes propostos:

1. **`motor_reactions.condition_json` (NOVA COLUNA, nullable)** — hoje a reação é
   escolhida só pelo número de ocorrência. Para regras do tipo "se
   `error_class = environment_failure` então ação Z" ou "se `attempt >= max`
   então Atenção", adicionar condição estruturada avaliada pelo
   `RuleEvaluator` (JSON puro, sem eval):
   ```json
   { "all": [
     { "field": "errorClass", "op": "eq", "value": "environment_failure" },
     { "field": "attempt", "op": "gte", "value": 2 }
   ]}
   ```
   Sem `condition_json` → comportamento atual (só ocorrência). Migração aditiva,
   compatível.
2. **População do catálogo** — criar eventos/padrões/reações faltantes para os
   cenários hardcoded mapeados (exemplos):
   - `E36_DEPLOY_FAILED` (patterns contains: "script blue-green", "Unknown column",
     "returned failed:128") → reações: 1ª = `retry_deploy_with_cooldown`,
     2ª = `block_task_for_attention`;
   - `E37_WORKER_EXHAUSTED`, `E38_QUEUE_DLQ`, `E39_BASELINE_RED`,
     `E40_PROMOTION_CONFLICT`;
   - E02/E03/E05/E10 já existem com padrões e reações — serão **reutilizados**
     quando H2/H3 forem conectados (fallback de modelo e resposta inválida já
     estão catalogados: `escalate_model`, `cooldown_model`, `send_feedback`...).
3. **`motor_events` — coluna `source_point` (opcional)** — registrar de qual
   ponto do código o evento é emitido (H1, H6, H12...) para rastreabilidade da
   migração. Pode ser convenção no `name`/descrição em vez de coluna.
4. **Versionamento de regras** — `motor_actions` e `motor_reactions` já têm
   `active`; para rollback, adicionar `version` + manter histórico desativado em
   vez de deletar (a tela nunca faz DELETE físico).

### 4.2 Código (motor-v3)

1. **NOVO `GovernedFailureHandler`** (fachada única):
   ```
   handleFailure(contexto, erro) →
     1. normaliza erro {code, message, stack, actionResult}
     2. EventClassifier.classify()
     3. match → RuleEvaluator aplica condition_json (se houver) → ação
     4. ActionExecutor.executeAction(acao, contexto)
     5. sem match → MonitorBridge.handleUncataloguedError() (proposta B01)
     6. fallback final (flag desligada ou erro no pipeline) → comportamento
        hardcoded atual (nunca piora)
   ```
2. **Ligar cada ponto hardcoded ao handler, UM por vez, atrás de flag**
   (`motor_configuracoes`: `governed_failure_<ponto> = true/false`):
   - Fase 1: **H1** (falha de análise — o exemplo do Alexandre) + **H2/H3**
     (o catálogo E02/E03/E10 já tem padrões e reações prontos para isso);
   - Fase 2: **H6/H7** (worker esgotado, rework) e **H10** (baseline vermelho);
   - Fase 3: **H12/H13/H14** (deploy) e **H17** (DLQ);
   - Fase 4: demais (H4, H9, H15, H16, H18).
3. **Conectar `ActionExecutor`** ao fluxo real (hoje órfão) — o
   `GovernedFailureHandler` passa a ser o chamador de produção.
4. **Implementar `MonitorBridge.invokeMonitor()`** (hoje TODO) ou manter o
   caminho de proposta apenas para revisão humana (caso B/C) — decidir com o
   Alexandre se erros não catalogados devem gerar proposta automática via LLM.
5. **Invariantes (não negociáveis, fora das regras):**
   - `record_operation_log` / `motor_event_log` executam sempre;
   - primitivas seguem idempotentes (reentrega de mensagem não duplica efeito);
   - contagem de ocorrências com escopo (tarefa, subtarefa, geração) impede loop
     infinito — a cadeia de reações termina em ação `is_terminal` (ex.: bloquear
     para Atenção);
   - ação default "bloquear para Atenção" **não pode ser removida** do catálogo
     (validação na tela + seed imutável).
6. **Testes de ouro (golden tests):** replay dos incidentes reais (862 claim
   órfão, 863 NaN deploy, 864 git 128, 866 prompt-catalog) contra o catálogo,
   garantindo que as regras reproduzem o comportamento corrigido. Cada ponto
   migrado exige teste de paridade (flag off = flag on com regras equivalentes).

### 4.3 API / Biblioteca

1. Endpoints CRUD para as entidades do catálogo (hoje só leitura):
   `POST/PATCH /gerenteagentes/motor-v3/tabelas/:tabela/:id` com validação:
   - primitiva referenciada existe e está registrada no código;
   - ação tem ≥1 primitiva e `on_partial_failure` válido;
   - reação aponta para evento e ação ativos;
   - padrão compila (se `regex`);
   - não desativar a última reação terminal de um evento de erro.
2. **Endpoint de simulação (dry-run):** `POST /gerenteagentes/motor-v3/simular`
   — recebe um erro bruto (ou seleciona um do `motor_event_log`/histórico de
   incidentes) e retorna: evento classificado, ocorrência, reação escolhida,
   ação e primitivas que seriam executadas — **sem executar nada**.
3. Reload do catálogo sem restart (o `CatalogLoader` já carrega por chamada;
   confirmar cache/invalidação ao editar via tela).
4. Auditoria de mudanças: quem editou o quê → `motor_catalog_proposals`
   (source='human') ou tabela de histórico dedicada.

### 4.4 Tela (`MotorV3TablesScreen.tsx` → evoluir)

1. Manter a leitura atual (combo agrupado) como visão "tabelas cruas".
2. Adicionar visão **regra legível**: para cada evento de erro, mostrar a cadeia
   em linguagem humana — "E02 · Modelo indisponível: 1ª vez → põe o modelo em
   cooldown e tenta o próximo; 2ª → idem; 3ª → bloqueia a tarefa para Atenção"
   (descrição vem de `motor_events.name` + `motor_actions.name`).
3. Edição inline com as validações do 4.3 + botão **Simular** (dry-run) antes de ativar.
4. Botão "desativar" (nunca deletar) + histórico de versões.
5. Painel de ocorrências: quantas vezes cada evento disparou, última vez, em
   qual tarefa (hoje `motor_occurrences` daria 0 — depois da conexão, vira o
   termômetro da autonomia do motor).

---

## 5. Estratégia de migração (resumo)

```
Fase 0  Documentar (este arquivo) + seeds de eventos faltantes (E36–E40)
Fase 1  GovernedFailureHandler + conectar H1/H2/H3 (análise) atrás de flag
        → golden tests dos incidentes 862/866
Fase 2  H6/H7/H10 (workers/rework/baseline)
Fase 3  H12/H13/H14/H17 (deploy/DLQ) → golden tests 863/864
Fase 4  CRUD na API + evolução da tela + simulação
Fase 5  Remover os ramos hardcoded substituídos (código encolhe)
```

Princípios:

- **Cada fase é independente e revertível** (flag por ponto);
- **Comportamento idêntico primeiro, melhoria depois** — só após a paridade é
  que se ajustam reações via tela;
- **Nunca sem teste de ouro** do cenário real que motivou a migração;
- O motor em produção segue o **catálogo governável** — código novo de decisão
  só entra se for primitiva.

---

## 6. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Regra malfeita trava o motor | Validações no CRUD + ação terminal default imutável + dry-run obrigatório na tela |
| Loop infinito de reações | `motor_occurrences` por geração + cadeia finita com última reação terminal |
| Erro não catalogado sem tratamento | Fallback: `MonitorBridge` (proposta) → e se nada, comportamento hardcoded atual |
| Regressão silenciosa na migração | Golden tests + flag por ponto + comparação `motor_operation_log` antes/depois |
| Catálogo e código divergirem (primitiva registrada ≠ tabela) | Startup valida: toda primitiva de `motor_actions` existe no registro; alerta no `/stats` |
| Edição concorrente do catálogo | Otimista: `updatedAt` + bloqueio de edição na tela (uma pessoa por entidade) |

---

## 7. Resposta direta à pergunta do Alexandre

> "É viável migrar aos poucos as decisões hardcoded para o formato governável?"

**Sim — e a maior parte da infraestrutura já existe.** O mecanismo
eventos → padrões (exact/contains/regex) → ocorrências → reações progressivas →
ações (sequência de primitivas em JSON) → executor com compensação está
implementado, testado e **populado** em produção (35 eventos, 18 padrões,
21 reações, 26 ações). O que falta é:

1. **Conectar** o pipeline aos ~18 pontos de decisão hardcoded mapeados na §3
   (hoje `classify()` e `executeAction()` não têm chamadores de produção);
2. Uma **coluna nova** (`motor_reactions.condition_json`) para condições além da
   contagem de ocorrência;
3. **Seeds** de eventos para deploy/DLQ/baseline/worker (E36–E40);
4. **CRUD + simulação** na API e evolução da tela MotorV3TablesScreen (hoje só leitura);
5. **Implementar ou decidir** o caminho do `MonitorBridge.invokeMonitor()` (TODO).

Depois disso, a afirmação se confirma: **desenvolver passa a ser criar
primitivas**; decisões de "o que fazer quando X falha" viram dados gerenciados
pela tela, com auditoria e rollback.
