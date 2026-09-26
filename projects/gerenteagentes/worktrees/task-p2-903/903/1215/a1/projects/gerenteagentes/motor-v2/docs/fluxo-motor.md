# Fluxo do Motor v2

**Atualizado em:** 2026-08-30 18:05 UTC

**Referência:** `docs/fluxo-motor.md` do Motor v1 (pasta `GerenteAgentes` — somente leitura).

---

## Situação atual

O Motor-v2 está **deployado no container real** (`biblioteca-global-api`, porta 3010, health OK). O código foi reorganizado e corrigido:

- Módulo `gerenteagentes` movido de `apps/api/src/modules/` para `projects/gerenteagentes/api/`
- Novos projetos de chat adicionados: `isa-chat`, `alpha-chat`, `chat-proxy`
- Novo pacote `file-extract` para extração de conteúdo
- Migração 0014 (paralelismo) aplicada
- **Correções aplicadas (2026-08-30):**
  - Timeout do watchdog: 90s → 10 minutos (`TaskCoordinator.ts`)
  - Lease do recurso: 60s → 10 minutos (`Motor.ts`)
  - Roteamento da Biblioteca para o Motor-v2 (`gerenteagentes.service.ts`): quando `MOTOR_VERSION=v2`, motor-detail/start(enqueue)/pause/resume chamam `http://127.0.0.1:3010/api/motor/*` (sem Host header de proxy); v1 permanece para dev
  - Tela Acompanhar Tarefa: subtarefas do banco como fallback + botão Iniciar desabilitado quando a tarefa já existe no motor
  - Máquina de estados: `planned -> fail` aceito (falha ambiental antes da análise)
  - Workspace do agente: `MOTOR_WORKSPACE_ROOT=/data/workspace/projects/agentes/gerenteagentes/worktrees` + volume mount
- **Correções da sessão noturna (2026-08-30, validação P0):**
  - Repo inexistente não entra mais em loop de retry: `prepare` classifica ENOENT como bloqueio ambiental e o coordenador persiste `bloqueios` + subtarefa/tarefa `blocked` (novo `ready -> fail -> blocked`)
  - `prepare`/`integrate` ignoram arquivos untracked (`--untracked-files=no`) — untracked de outra sessão não trava mais o motor
  - Pausa devolve a subtarefa interrompida para `pending` (antes ficava órfã em `verifying` e o resume não retomava)
  - Push do GitHub: chave SSH montada read-only no container (`GIT_SSH_COMMAND` + volume no compose); fase PUBLISH funciona em produção
- Branch: `base-desenvolvimento`, commits `0defb7c`, `e522283`, `43489ae`, `78f5df5`, `338baca`, `c4d2da0`, `0731be1`, `7464754`, `a2a9772`, `b3f7ebb`, `3efac68`, `856b8b8`

---

## Cenários validados em E2E isolado

| Cenário | Evidência | Resultado |
|---------|-----------|-----------|
| **Cenário feliz** | `e2e-isolated-ok-1788048496` | 2 subtarefas sequenciais, commit `3077c4e`, branch publicada/integrada, worktree limpo |
| **Rework** | `e2e-rework-20260830-002` | Gate vermelho → reentrega → aprovação, `deliver_count=2`, commit `63d83dd` |
| **Escada de modelos** | `e2e-model-chain-20260830-010` | Modelo inválido recusado → salto para `qwen3.7-plus` → análise com 4 subtarefas |
| **Sessões** | `e2e-close-session-20260830-001` | Labels `analysis-*`/`dev-*`, encerramento via `DELETE /api/sessions`, zero sessões remanescentes |

---

## Estado das capacidades

| Capacidade | Status | Observação |
|------------|--------|------------|
| Planejamento persistido | ✅ Validado | Persistência transacional, retomada sem replanejar |
| Execução sequencial | ✅ Validada | Coordinator single-flight, 2 subtarefas em sequência |
| Gate independente | ✅ Validado | Build+teste antes de `verified`; gate verde real na #727 (`tsc` + vitest 67/67) |
| Rework com feedback | ✅ Validado | `deliver_count=2`, correção de `max_rework`/`hard_timeout_ms` |
| Escada de modelos | ✅ Validada | Fase ANALYZE itera pela cadeia; na #727 fallback `ollama/qwen3.7-plus` indisponível → `openai/gpt-5.6-luna` |
| Sessão identificável | ✅ Validada | Labels padronizados, encerramento correto |
| Worktree/commit/merge | ✅ Validado | Commit, publicação e merge reais na #727 (branch `motor-v2/727/717/a3` → `base-desenvolvimento`, merge `0cecbd5`) |
| Bloqueio ambiental | ✅ Validado | Tarefa 728: repo inexistente → `bloqueios` persistido + tarefa `blocked`, sem loop de retry |
| Pausa/cancel/retomada | ✅ Validado | Pausa na #727 durante gate (worker SIGKILL, tarefa `paused`), resume retomou; cancel validado na #730 |
| Concorrência/fencing | ⚠️ Parcial | `MOTOR_MAX_WORKERS=1` em produção; pump multi-worker implementado e testado (preenchimento, limite por projeto, isolamento de falha) — ativar 2+ workers é decisão de rollout (P1) |
| Subtarefa de correção | ✅ Validada | Tarefa 730: gate falhou 2x com mesmo fingerprint → correção criada automaticamente em banco/git reais |
| Realtime/Broadcaster | ⚠️ Parcial | Código deployado (`38a0686`); validação ponta a ponta do feed pendente com a sessão dona da feature |

---

## Validações no ambiente real (concluídas em 2026-08-30)

1. **Bloqueios ✅** — `blocked_environment` ao vivo (tarefa 728), persistido em `bloqueios`; falhas sistêmica/transitória cobertas pelos testes isolados
2. **Pausa/cancel/retomada ✅** — pausa na #727 durante o gate, retomada após resume; cancel na #730
3. **Concorrência ⚠️ parcial** — limite global 1 worker; exclusão por projeto observada; fencing só em teste isolado
4. **Subtarefa de correção ✅** — tarefa 730, fingerprint repetido em banco/git reais
5. **Realtime ⚠️ parcial** — deployado; feed ponta a ponta pendente

**Caminho feliz #727 ✅ COMPLETED:** análise → worktree → dev → gate verde → commit → publish SSH no GitHub → merge → validação → `completed`.

**Pendências conhecidas:** `saveTask` grava `errorMessage` na coluna `descricao`; falha de integração não gera linha em `bloqueios`; `GET /api/motor/task/:id` não inclui subtarefas.

---

## Estrutura do código

```
projects/gerenteagentes/
├── api/                          # Módulo NestJS (controller, service, isa-chat)
├── motor-v2/
│   ├── src/
│   │   ├── coordinator/          # TaskCoordinator (scheduler)
│   │   ├── workers/              # WorkerLauncher, TaskWorker
│   │   ├── resources/            # ResourceLeaseService, EventBus
│   │   ├── execution/            # ExecutionContextManager
│   │   ├── reconciler/           # ExpirationReconciler
│   │   ├── api/                  # MotorAPI (REST)
│   │   ├── Motor.ts              # Entry point
│   │   └── start.ts              # Inicialização
│   ├── test/                     # 15 arquivos, 66 testes
│   └── docs/
│       └── fluxo-motor.md        # Este documento
├── migrations/                   # 0013 (resource_queue), 0014 (paralelismo)
└── schema.ts                     # Drizzle schema
```

---

## Testes

```bash
cd projects/gerenteagentes/motor-v2
npm test          # 15 arquivos, 66 testes
npm run typecheck
npm run lint
```

---

## Health check

```bash
curl http://localhost:3010/api/motor/health
# {"ok":true,"runtime":"motor-v2","timestamp":"..."}
```

---

## Referências

- [PENDENCIAS.md](../../../../../../agentes/gerenteagentes/PENDENCIAS.md) — inventário operacional
- [README.md](../README.md) — arquitetura e uso
- [Fluxo do Motor v1](../../../../../../GerenteAgentes/docs/fluxo-motor.md) — referência legada
