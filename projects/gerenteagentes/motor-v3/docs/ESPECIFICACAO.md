# ESPECIFICAÇÃO TÉCNICA — MOTOR-V3

> **Status:** esqueleto inicial (FASE 1 do LOG); preencher seções em ciclos sucessivos.
> **Branch:** `motor-v3` | **Pasta:** `projects/gerenteagentes/motor-v3/`
> **Decisões de desenho:** `docs/MOTOR-V2-SIMULACAO-TEXTUAL.md` §9/§9.5/§10.3
> **Padrão da arquitetura:** `docs/MOTOR-V3-EVENT-DRIVEN.md`

---

## 1. Objetivo

Substituir o Motor-v2 por um motor **event-driven**, com:

- Catálogo de eventos/reações **configurável em banco** (zero ifs hardcoded para erro/recuperação).
- **Conversa livre** com o agente (em substituição ao contrato JSON de auto-relato); verificação de realidade pelo motor.
- **Muros de capacidade** (sandbox OpenClaw + mounts + rede) em vez de muros de instrução (prompt/convenção).
- **Observabilidade total**: middleware de log em cada mensagem/evento/ação.
- **Aprendizado autônomo limitado**: Monitor (modelo caro) pode propor novas entradas no catálogo, com travas (D4).

## 2. Princípios de Design (síntese das decisões D1–D9)

1. **BIG BANG** (D1): pasta/branch novas; v2 parado durante o desenvolvimento; rollback possível via `MOTOR_VERSION`.
2. **Sandbox opção (a)** (D2): raiz de worktrees montada, opção (b) runner descartável só se precisar.
3. **"Terminei" híbrido** (D3): marcador mínimo + verificação de realidade sempre decide.
4. **Monitor auto-ativa Caso A** (D4): log + pendente revisão humana.
5. **Reset de ocorrências** (D5): tarefa+subtarefa+geração de worktree.
6. **Liberdade igual, teto diferente** (D6): local 2 tentativas, cloud 3.
7. **Só v3** (D7): zero remendos no v2.
8. **Quem desenvolve:** este agente, não via tarefas do motor (D8).
9. **Plano de validação** (D9): trivial → complexa → verificação → automação, tudo logado.

## 3. Componentes / Módulos

### 3.1 MessageBus

- In-memory, síncrono, dentro do processo do motor (broker externo = futuro).
- API: `send(message)`, `on(type, handler)`, `off(type, handler)`.
- Garante ordem **dentro de um mesmo tópico** por `taskId+subtaskId` (fila interna por chave).
- Tipos de mensagem: evento (do sistema) / comando (da API) / conversa (humano↔agente).

### 3.2 EventLogger (middleware)

- Log estruturado de cada mensagem que passa: `[ENVIADA]/[RECEBIDA]/[EVENTO]/[AÇÃO]`.
- Sink: stdout + arquivo rotativo + (futuro) tabela `motor_event_log`.
- Cada entrada carrega `taskId`, `subtaskId`, `model`, `generation`, `timestamp`, `correlationId`.

### 3.3 CatalogLoader

- Carrega o catálogo (primitivas/ações/patterns/eventos/reações) do banco.
- Cache em memória, invalidado por `CATALOG_CHANGED` (emitido pelo Admin API em UPDATE/INSERT).
- Hot reload sem restart.

### 3.4 EventClassifier

- Dado um input (código + mensagem + action_result), percorre eventos ativos por `priority`, testa patterns, retorna `{event, occurrence, reaction}` ou `null` (dead letter).
- Incrementa contador atômicamente (`INSERT ON DUPLICATE KEY UPDATE count=count+1`) → resolve B13.
- Escopo de contagem: `(event_id, task_id, subtask_id, generation)`.

### 3.5 ActionExecutor

- Executa ação por id; composição ordenada de primitivas com semântica de falha parcial (B20):
  - `on_partial_failure`: `continue | compensate | mark_dirty` (por ação).
  - Default: `continue` para ações observacionais, `compensate` para ações destrutivas.
- Handlers de primitiva são registráveis (`registerPrimitive(name, fn)`).

### 3.6 Primitivas (~32, vide doc 2 §3)

Código fixo, atômico, não configurável via banco. Adicionar nova primitiva = código + redeploy.

### 3.7 MotorContext

Objeto de contexto passado a primitivas/handlers:
- sessão, driver, modelo atual, cadeia, geração
- tarefa, subtarefa, execução, fase
- db, flags (`skipCurrentModel`, `escalateModel`, `archiveSession`), erro original.

### 3.8 WorkerLauncher (conversacional)

- Lança o agente em sandbox OpenClaw (opção a — D2).
- Protocolo de conversa: missão em texto livre + canal bidirecional + marcador mínimo do "terminei".
- Motor faz o bookkeeping git (commit/merge/push/promote/deploy) — agente nunca toca em credencial git.
- Teto por tier (D6): local 2 tentativas → Monitor; cloud 3.

### 3.9 Scheduler / Heartbeat

- Injeta eventos temporais no bus: `TIMEOUT_IDLE`, `TIMEOUT_ABSOLUTE`, `COOLDOWN_EXPIRED`, `PROBE_CONSOLE`.
- Reaproveita o `ExpirationReconciler` do v2 (B05 — resolve o buraco "fila pausada para sempre").
- Tick configurável (default 30s).

### 3.10 Reconciler (herdado)

- `ExpirationReconciler`: detecta tarefas órfãs (worker sumiu), leases expirados, análises estagnadas.
- Emite eventos no bus em vez de executar ações diretas.

### 3.11 Bookkeeper

- Motor faz: `commit_changes`, `merge_branch`, `revert_merge`, `publish_branch`, `promote_to_base`, `enqueue_deploy`.
- Lock de integração por projeto (`withProjectIntegrationLock`, herança do v2).
- Estado de compensação: `promotion_dirty` flag (B20).

### 3.12 Monitor Bridge

- Invoca o Monitor (cadeia MONITOR do `project_model_selection`, sessão fixa "Monitoramento Motor", lease `motor:monitor`) em:
  - Erro não catalogado (B01 — Casos A/B/C)
  - Gate persistente após N tentativas
  - Promoção falhada com conflito na base (B07)
- Resposta estruturada: `CATALOG_ENTRY_PROPOSED` (com diagnóstico) ou `AGUARDANDO_USUARIO`.
- Limites: nunca cria microcomando/handler novo (travas D4); Caso B entra `active=0`.

## 4. Fluxos

### 4.1 Análise

```
TASK_CREATED → pump → selectNextTask (análise tem 1 vaga global)
  → WorkerLauncher (sandbox + conversa) → ANALYSIS_COMPLETED
  → parse_reply + persist_plan + create_subtasks
  → TASK_READY_FOR_PROGRAMMING
```

Falha no parse: retry corretivo (1x) → Monitor → humano.

### 4.2 Execução

```
SUBTASK_PENDING → pump → selectNextSubtask (respeita maxWorkers/maxPerProject)
  → prepare_workspace (create_worktree + install_dependencies)
  → WorkerLauncher (sandbox + conversa)
  → "terminei" (marcador) → verify_workspace → run_build
     ├─ verde → commit_and_merge → gate de integração
     │           ├─ verde → publish_and_mark_integrated
     │           └─ vermelho → revert_and_return → subtask volta p/ pending
     └─ vermelho → send_feedback (cadeia progressiva)
```

### 4.3 Erro / recuperação (catálogo)

```
falha → EventClassifier → {event, occurrence, reaction}
  → ActionExecutor executa reação (primitivas em sequência)
  → MotorContext.flags alteram o fluxo (escalate/retry/block/archive)
```

Cadeias progressivas (D5 reset, D6 teto):
- E01 estouro contexto: 1x sanitize, 2x escalate+cooldown, 3x block.
- E08 build falhou: 1x feedback, 2x sanitize, 3x escalate, 4x block.
- E09 gate integração: 1x revert.

### 4.4 Erro não catalogado (B01 — Monitor)

```
classifier retorna null
  → quarantine_and_diagnose = block_subtask + capture_diagnostic + notify_admin
  → Monitor analisa:
       Caso A (variação de evento existente) → CATALOG_ENTRY_PROPOSED (auto-ativa pattern conservador, com log pendente revisão)
       Caso B (evento novo)                 → CATALOG_ENTRY_PROPOSED (active=0, aguarda humano)
       Caso C (não resolve)                 → AGUARDANDO_USUARIO
  → após aprovação (humano ou auto) → auto_unblock_and_pump
```

### 4.5 Conversa livre

- Mensagem humana com run ativo → checkpoint (entregue na próxima retomada; só o par mais recente).
- Agente pergunta algo → `AGUARDANDO_USUARIO` → UI → resposta injetada.
- "Terminei" = marcador mínimo (palavra/flag) + verificação de realidade SEMPRE.

## 5. Schema SQL

### 5.1 Tabelas herdadas (sem alteração estrutural)

`tarefas`, `subtarefas`, `bloqueios`, `projeto_motor_config`, `projeto_model_selection`, `tarefa_chats`, `tasks`/`subtasks` etc.

### 5.2 Tabelas novas do catálogo

Conforme `docs/MOTOR-V3-EVENT-DRIVEN.md` §6.1:
- `motor_primitives`, `motor_actions`, `motor_action_primitives`,
- `motor_patterns`, `motor_events`, `motor_event_patterns`,
- `motor_event_reactions`, `motor_event_occurrences` (com coluna `generation` para reset — B13),
- `motor_model_cooldown` (herdada),
- `motor_promotion_state` (flag `dirty`, `conflict_files_json`, `attempts` — B20).

### 5.3 Ajustes específicos

- **B13** reset: `uk_event_scope (event_id, task_id, subtask_id, generation)`; `generation` é `aN` do worktree.
- **B19** regra de fim de cadeia: gatilho de validação `BEFORE INSERT` em `motor_event_reactions` — se a maior `occurrence` de um evento tiver ação não-terminal E sem successor, rejeita.
- **B20** compensação: `motor_actions` ganha coluna `on_partial_failure ENUM('continue','compensate','mark_dirty') DEFAULT 'continue'`.

## 6. Contrato de Conversa Livre

### 6.1 Marcador mínimo do "terminei"

Única estrutura exigida: uma palavra/flag reconhecível ao fim da resposta do agente, p.ex. `::DONE::` ou `[ENTREGA]`. **O motor NUNCA confia só no marcador** — sempre roda verify + build + testes. Se o agente esquecer o marcador, o idle timeout ou a próxima mensagem humana dispara a verificação.

### 6.2 Checkpoints

Mensagem humana durante run: armazenada em `tarefa_chats` com flag `pending`; na próxima retomada o motor injeta **só o par pergunta+resposta mais recente** (decisão 15/09).

### 6.3 Verificação de realidade

Sempre após "terminei":
1. `git status` / `git diff --stat` (tem alteração?)
2. `build_command` do projeto_motor_config (exit code 0?)
3. `unit_test_command` (exit code 0?)
4. lista de paths modificados vs `allowed_paths` da tarefa.

Se 1–4 passam → motor faz commit+merge+gate+publish. Se algum falha → motor devolve a saída como mensagem de conversa (não como gate event com cadeia de 4 estágios). Teto de tentativas por tier (D6).

### 6.4 Tetos por tier (D6)

| Tier | Tentativas antes do Monitor | Tentativas antes de bloqueio |
|------|------------------------------|------------------------------|
| Local | 2 | 3 |
| Cloud | 3 | 5 |

## 7. Sandbox e Muros

### 7.1 Config OpenClaw (opção a — D2)

- `agents.list[<agentId>].sandbox`: `mode: non-main | all`, `scope: session`, `backend: docker`.
- `docker.network`: rede restrita (allowlist Console/Ollama/npm).
- `docker.readOnlyRoot: true`, `capDrop: ["ALL"]`.

### 7.2 Binds

- `worktree da subtarefa` → `/work` (rw, único ponto de escrita).
- `references declaradas na tarefa` → `/refs/<n>` (ro).
- **NÃO** montar: `~/.ssh`, docker.sock, outros workspaces, `secrets/`, `.env`.

### 7.3 Rede

Default `none` + allowlist:
- `http://127.0.0.1:6280` (Console OpenClaw — conversa)
- `http://ollama:11434` (modelo local, quando aplicável)
- `https://registry.npmjs.org` (npm ci)
- provedores cloud de modelo (quando tier=cloud)

### 7.4 Agente sem credencial git

Push/merge/publish/promote/deploy são ações do MOTOR, executadas FORA do sandbox (no processo do motor, que tem credenciais). O agente não precisa e não tem acesso a chave SSH/token git. Resolve de tabela o dilema da tarefa 832: `allowed_paths` = mounts.

## 8. Deploy / Cutover

### 8.1 Big Bang (D1)

- Motor v2 PARADO (processo morto via SIGTERM; se o container recriar, verificar e derrubar de novo).
- Motor v3 sobe em branch `motor-v3` + pasta `projects/gerenteagentes/motor-v3/`.
- `MOTOR_VERSION` no container: `v3` quando pronto.

### 8.2 Migração de dados

- Tabelas novas criadas via migration Drizzle (`db:migrate:gerenteagentes`).
- Seed do catálogo: eventos/ações/patterns base (herdados do v2, documentados no doc 2).
- Dados de `tarefas`/`subtarefas` permanecem.

### 8.3 Rollback

- `MOTOR_VERSION=v2` (volta o processo antigo; tabelas novas ficam inertes).
- Rollback de dados: não aplicável (as tabelas novas não foram preenchidas pelas tarefas em andamento).

## 9. Plano de Testes

### 9.1 Unitários por módulo

- MessageBus: ordem, broadcast, erro em handler não derruba os outros.
- CatalogLoader: cache, hot reload, integridade do catálogo.
- EventClassifier: priority, pattern matching (contains/regex/exact/code), atomicidade da ocorrência, escopo `generation`.
- ActionExecutor: semântica de falha parcial (continue/compensate/mark_dirty).

### 9.2 Integração

- Fluxo completo com tarefa mock (analista + programador fake): TASK_CREATED → ANALYSIS_COMPLETED → SUBTASK_SELECTED → PROGRAMMING_COMPLETED → promoção → deploy enfileirado.
- Simulação dos 6 cenários do doc 2 §5.

### 9.3 Teste piloto (D9)

- Tarefa trivial num projeto qualquer (ex.: Administrador Global — mudar um texto ou uma cor).
- Validar: sandbox, conversa, marcador, verificação de realidade, bookkeeper, promoção, deploy.

### 9.4 Escalonamento (D9)

- Piloto OK → tarefa um pouco mais complexa → … → tarefa de desenvolvimento complexa.
- Cada falha: analisar causa, corrigir o motor (não remendar), retestar.

### 9.5 Verificação + automação (D9)

- Repetir o ciclo com tarefas tipo `verificacao` (auditoria, métricas) e `automacao` (Instagram, Telegram, integrações).
- Validar que o catálogo comporta eventos não previstos (B01) via Monitor.

## 10. Fases de Implementação

### F1 — Fundações

- Schema + migrations do catálogo.
- MessageBus + EventLogger.
- CatalogLoader com cache.
- Testes unitários F1.

### F2 — Classificação e reação

- EventClassifier.
- ActionExecutor + primitivas (herdando as 32 do v2).
- Seed inicial do catálogo.
- Testes unitários F2 + cenário 2/3/5 do doc 2.

### F3 — Conversa + bookkeeper

- WorkerLauncher conversacional (sandbox OpenClaw opção a).
- Bookkeeper (commit/merge/publish/promote/deploy).
- Lock de integração herdado.
- Teste de fluxo feliz (cenário 1).

### F4 — Scheduler + reconciler + Monitor Bridge

- Scheduler/Heartbeat (B05).
- Reconciler herdado adaptado para emitir eventos.
- Monitor Bridge (B01 Casos A/B/C, D4).
- Testes cenários 4/6.

### F5 — Sandbox e muros finais

- Config OpenClaw aplicada (D2).
- Binds + rede allowlist + sem credencial git.
- Teste de invasão: agente "mentindo" sobre ambiente / tentando sair do worktree.

### F6 — Piloto e escalonamento (D9)

- Tarefa trivial → complexa → verificação → automação.
- Log de cada teste no `docs/MOTOR-V3-LOG.md`.

## 11. Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| Motor v3 não cobre todas as situações do v2 | Piloto D9 com tarefa real antes de aposentadoria |
| Zombie `[node]` no container da API (motor v2 morto) | Inócuo; some no próximo restart; LOG monitora |
| Container recriado → motor v2 ressurge (entrypoint) | Cron horário verifica 3010 e mata de novo |
| SSH volta a falhar (DHCP) | Usar `host.docker.internal` (imune); .8 é fixo por decisão do Alexandre |
| Sandbox limita ferramenta legítima | Lista de allowed_paths declarada na criação da tarefa |
| Monitor propõe reação destrutiva por engano | Travas D4 (log + pendente revisão + nunca cria microcomando) |
| Modelo local fica sem vRAM em paralelismo | Um modelo local por vez (regra do workspace) |

## 12. Dependências Externas

- OpenClaw Gateway (sandbox + Console API para sessões).
- Ollama (modelos locais) / provedores cloud.
- MySQL `projeto_640` (banco do motor).
- npm registry (para `npm ci` no worktree).
- GitHub SSH (push de branches — credenciais no MOTOR, não no agente).
- Cloudflare Tunnel (API pública `biblioteca-api.webconnect.com.br`).

## 13. Critérios de Pronto (por fase)

- **F1:** migrations rodam; bus + logger com 100% coverage; catálogo carrega do DB.
- **F2:** classifier classifica 100% dos erros conhecidos do v2; executor executa as 5 ações base; cenários 2/3/5 passam.
- **F3:** fluxo feliz (cenário 1) ponta a ponta em sandbox; bookkeeper sem intervenção manual.
- **F4:** cenários 4/6 passam; Monitor resolve pelo menos 1 erro não catalogado (Caso A).
- **F5:** agente não consegue sair do worktree (teste adversarial); nenhum git credential dentro do sandbox.
- **F6:** tarefas D9 (trivial → complexa → verificação → automação) todas passam com deploy.

---

**Próximos passos imediatos (após este esqueleto):**
1. Preencher cada seção com detalhes concretos (API types, exemplos de payload, SQL real).
2. Definir a API HTTP do motor v3 (`/api/motor/*`) — endpoints e contratos.
3. Desenhar a migration Drizzle (mover de SQL puro para migrations versionadas).
4. Desenhar o protocolo do marcador mínimo do "terminei" (D3).
5. Montar o seed do catálogo (eventos/ações/patterns) com base no doc 2 §2/§3.
