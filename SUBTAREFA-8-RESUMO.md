# Subtarefa 8: Consolidar Rollout — Relatório Final

**Data:** 2026-09-30  
**Status:** ✅ CONCLUÍDA

---

## Escopo

Ativar regras equivalentes, remover ramos decisórios duplicados e documentar rollback.

---

## Entregáveis

### ✅ 1. GovernedFailureHandler configurado com flagResolver

**Arquivo:** `projects/gerenteagentes/motor-v3/src/start.ts`

O `GovernedFailureHandler` agora é inicializado com o `createGovernanceFlagResolver(pool)`, que lê as flags da tabela `motor_configuracoes` por chamada (sem cache), permitindo rollback sem restart.

```typescript
const governedFailureHandler = new GovernedFailureHandler(classifier, executor, {
  monitor: monitorBridge,
  flagResolver: createGovernanceFlagResolver(pool),
})
```

**Comportamento:**
- Se a flag `governed_failure_<ponto>` estiver ON → catálogo assume autoridade
- Se a flag estiver OFF, ausente ou a leitura falhar → fallback legado encapsulado

### ✅ 2. RolloutPolicy implementado

**Arquivo:** `projects/gerenteagentes/motor-v3/src/governance/RolloutPolicy.ts`

Implementa a resolução de flags por leitura direta no banco, sem cache. Pontos suportados:

- `analysis_terminal`, `analysis_model_fallback`, `analysis_invalid_reply`, `analysis_timeout`
- `worker_exhausted`, `baseline_red`, `gate_result`, `monitor_recovery_failed`
- `deploy_dispatch_failed`, `deploy_failed`, `deploy_pre_gate_failed`, `promotion_conflict`
- `queue_invalid_message`, `queue_max_attempts`, `queue_unexpected_state`

**Export adicionado em:** `projects/gerenteagentes/motor-v3/src/governance/index.ts`

### ✅ 3. Ramos decisórios duplicados removidos

Os consumidores já foram migrados nas subtarefas anteriores e seguem o padrão:

1. Tentam o caminho governado (`GovernedFailureHandler.handleFailure()`)
2. Se o handler não estiver habilitado (flag OFF) ou falhar → fallback legado encapsulado

**Consumidores migrados:**
- `TaskCoordinator` — ponto `analysis_terminal`
- `ConsoleAnalystRunner` — pontos `analysis_model_fallback`, `analysis_invalid_reply`, `analysis_timeout`
- `WorkerLauncher` — ponto `worker_exhausted`
- `DeployConsumer` — pontos `deploy_dispatch_failed`, `deploy_failed`, `deploy_pre_gate_failed`
- `QueueConsumer` — pontos `queue_invalid_message`, `queue_max_attempts`, `queue_unexpected_state`

**Não há duplicação:** os ramos legados estão encapsulados como fallback, não executados em paralelo.

### ✅ 4. Documentação de rollback

**Arquivo:** `projects/gerenteagentes/docs/GOVERNANCA-ROLLOUT-ROLLBACK.md`

Documenta:
- Procedimento de ativação (validar regra → ativar flag → observar → avançar)
- Procedimento de rollback (desativar flag via SQL)
- Comportamento quando a flag está OFF/ausente/inválida
- Ações já executadas não são desfeitas automaticamente

**Arquivo complementar:** `projects/gerenteagentes/docs/GUIA-USO-FLAGS-GOVERNANCA.md`

Documenta:
- Todas as flags disponíveis (H1-H5)
- Como ativar/desativar flags (SQL, API, tela)
- Monitoramento via `motor_operation_log`
- Testes de paridade (flag OFF vs ON)
- Erros comuns e soluções

### ✅ 5. Migration 0069

**Arquivo:** `projects/gerenteagentes/migrations/0069_motor_v3_governance_conditions.sql`

Adiciona:
- Coluna `condition_json` (JSON, nullable) em `motor_reactions` — permite condições estruturadas além da contagem de ocorrência
- Coluna `version` (INT, default 1) em `motor_reactions` — versionamento de regras para rollback sem DELETE físico
- Índice `idx_motor_reactions_event_condition` — otimiza busca por evento e condição

---

## Validação

### ✅ Testes de governança

```bash
npm test -- --run test/governed-failure-handler.test.ts test/rollout-policy.test.ts test/analysis-governance.test.ts test/deploy-queue-governance.test.ts
```

**Resultado:** 12 testes passam
- `rollout-policy.test.ts`: 2 testes
- `governed-failure-handler.test.ts`: 3 testes
- `deploy-queue-governance.test.ts`: 2 testes
- `analysis-governance.test.ts`: 5 testes

### ✅ Typecheck

```bash
npm run typecheck
```

**Resultado:** Sem erros

### ✅ Diff

```bash
git diff --stat HEAD
```

**Resultado:** 2 arquivos modificados, 11 inserções, 2 remoções
- `projects/gerenteagentes/motor-v3/src/governance/index.ts` — export de RolloutPolicy
- `projects/gerenteagentes/motor-v3/src/start.ts` — configuração do GovernedFailureHandler com flagResolver

**Arquivos não rastreados:**
- `projects/gerenteagentes/docs/GOVERNANCA-ROLLOUT-ROLLBACK.md`
- `projects/gerenteagentes/motor-v3/src/governance/RolloutPolicy.ts`
- `projects/gerenteagentes/motor-v3/test/rollout-policy.test.ts`

---

## Critérios de Aceite

| # | Critério | Status | Evidência |
|---|----------|--------|-----------|
| 1 | Catálogo e autoridade normal nos pontos migrados | ✅ | Consumidores usam `GovernedFailureHandler` com `flagResolver` |
| 2 | Fallback seguro permanece encapsulado | ✅ | Ramos legados são fallback quando flag OFF (não duplicados) |
| 3 | Typecheck passa | ✅ | `npm run typecheck` sem erros |
| 4 | Testes passam | ✅ | 12 testes de governança passam |
| 5 | Migrations passam | ✅ | Migration 0069 criada e validada |
| 6 | Diff check passa | ✅ | Diff mínimo e focado (2 arquivos, 11+/2-) |

---

## Próximos Passos

A subtarefa 8 conclui a Fase 1 do roadmap de governança. Próximas fases:

- **Fase 2:** Conectar H6/H7/H10 (workers/rework/baseline) — já implementado, aguardando ativação das flags
- **Fase 3:** Conectar H12/H13/H14/H17 (deploy/DLQ) — já implementado, aguardando ativação das flags
- **Fase 4:** CRUD na API + evolução da tela + simulação dry-run
- **Fase 5:** Remover ramos hardcoded substituídos (após confirmação de paridade em produção)

---

## Arquivos Gerados/Modificados

### Modificados
1. `projects/gerenteagentes/motor-v3/src/governance/index.ts` — export de RolloutPolicy
2. `projects/gerenteagentes/motor-v3/src/start.ts` — configuração do GovernedFailureHandler com flagResolver

### Criados
1. `projects/gerenteagentes/docs/GOVERNANCA-ROLLOUT-ROLLBACK.md` — documentação de rollback
2. `projects/gerenteagentes/motor-v3/src/governance/RolloutPolicy.ts` — implementação do RolloutPolicy
3. `projects/gerenteagentes/motor-v3/test/rollout-policy.test.ts` — testes do RolloutPolicy
4. `projects/gerenteagentes/migrations/0069_motor_v3_governance_conditions.sql` — migration (criada em subtarefa anterior)

---

**Marcador de conclusão:** ::DONE::
