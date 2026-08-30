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
- Branch: `base-desenvolvimento`, commits `0defb7c`, `e522283`, `43489ae`, `78f5df5`, `338baca`, `c4d2da0`, `0731be1`, `7464754`

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
| Gate independente | ✅ Validado | Build+teste antes de `verified` |
| Rework com feedback | ✅ Validado | `deliver_count=2`, correção de `max_rework`/`hard_timeout_ms` |
| Escada de modelos | ✅ Validada | Fase ANALYZE itera pela cadeia, `status: "failed"` tratado |
| Sessão identificável | ✅ Validada | Labels padronizados, encerramento correto |
| Worktree/commit/merge | ✅ Validado | Commit, publicação, merge e limpeza |
| Bloqueio ambiental | ⏳ Implementado | Validação em produção pendente |
| Pausa/retomada | ⏳ Implementado | Validação em produção pendente |
| Concorrência/fencing | ⏳ Implementado | Migração 0014 aplicada, validação pendente |
| Subtarefa de correção | ⏳ Implementado | Validação em produção pendente |
| Realtime/Broadcaster | ⏳ Adaptador pronto | Integração WebSocket pendente |

---

## Próximas validações (no ambiente real)

1. **Bloqueios:** `blocked_environment`, falha sistêmica, falha transitória
2. **Pausa/retomada:** interromper entre subtarefas, conservar plano
3. **Concorrência:** duas tarefas em projetos distintos e no mesmo projeto
4. **Subtarefa de correção:** fingerprint + diff em Git/MySQL reais
5. **Realtime:** broadcaster → API → WebSocket → feed

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
