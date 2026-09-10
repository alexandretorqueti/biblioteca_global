# Evidências E2E — Observabilidade do Motor

> Subtarefa 8: Validação final, documentação e evidências da instrumentação de observabilidade.
> Data: 2026-09-10

## Resumo da execução

```
Test Files  50 passed (50)
     Tests  576 passed (576)
  Duration  5.37s
```

**Build:** `npx tsc` — sem erros.

---

## Cenários E2E validados

### Cenário 1: Sucesso na primeira tentativa

**Descrição:** Subtarefa executada, gate aprovado, verificada na tentativa 1.

**Resultados esperados e obtidos:**

| KPI | Esperado | Obtido |
|---|---|---|
| Avanço aceito | 100% (5/5) | ✅ 1.0 |
| Primeira aprovação | 100% | ✅ 1.0 |
| Retrabalho | 0% | ✅ 0 |
| Bloqueio | 0% | ✅ 0 |
| Lead time | 3600s (1h) | ✅ 3600 |
| Gate success | 100% (3/3) | ✅ 1.0 |
| Weight coverage | 100% | ✅ 1.0 |
| Deadline coverage | 100% | ✅ 1.0 |

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: Sucesso na primeira tentativa")`

---

### Cenário 2: Falha + retrabalho (2 tentativas)

**Descrição:** Subtarefa falhou na tentativa 1 (gate de teste), corrigida e verificada na tentativa 2.

**Resultados esperados e obtidos:**

| KPI | Esperado | Obtido |
|---|---|---|
| Avanço aceito | 100% (após retrabalho) | ✅ 1.0 |
| Primeira aprovação | 0% (verificou na tentativa 2) | ✅ 0 |
| Retrabalho | 100% (2 tentativas) | ✅ 1.0 |
| Lead time | 7200s (2h) | ✅ 7200 |
| Gate success | 75% (3/4: 1 failed + 3 passed) | ✅ 0.75 |

**Evidência de rastreabilidade:**
- Tentativa 1: `gate_type=test, status=failed`
- Tentativa 2: `gate_type=build, status=passed` + `gate_type=test, status=passed`
- `verified_attempt=2`, `attempt_count=2`

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: Falha + retrabalho")`

---

### Cenário 3: Bloqueio + retomada

**Descrição:** Duas subtarefas com bloqueio; uma verificada após retomada, outra ainda bloqueada.

**Resultados esperados e obtidos:**

| KPI | Esperado | Obtido |
|---|---|---|
| Avanço aceito | 37.5% (3/8) | ✅ 0.375 |
| Bloqueio | 100% (ambas têm bloqueio) | ✅ 1.0 |
| Primeira aprovação | 100% (a verified foi na tentativa 1) | ✅ 1.0 |
| Lead time | 14400s (4h, só a verified) | ✅ 14400 |

**Evidência de rastreabilidade:**
- Subtarefa 30: `status=verified, has_blocker=true, verified_attempt=1`
- Subtarefa 31: `status=running, has_blocker=true` (ainda bloqueada)
- Tempo bloqueado computado via `bloqueios` (abertura → resolução ou NOW())

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: Bloqueio + retomada")`

---

### Cenário 4: Deploy + smoke test reprovado

**Descrição:** Subtarefa verificada (aceite técnico), mas deploy com smoke test reprovado.

**Resultados esperados e obtidos:**

| KPI | Esperado | Obtido |
|---|---|---|
| Avanço aceito | 100% (subtarefa verified) | ✅ 1.0 |
| Confiabilidade pós-deploy | 0% (smoke reprovado) | ✅ 0 |

**Sub-cenários validados:**

| Caso | smoke_test_ok | Confiabilidade |
|---|---|---|
| Smoke reprovado | `false` | ✅ 0 |
| Smoke não executado | `null` | ✅ 0 |
| Mistura (1 ok, 1 fail, 1 null) | — | ✅ 1/3 |

**Evidência de independência:**
- Avanço técnico (verified) e confiabilidade pós-deploy (smoke) são KPIs independentes
- Deploy SEM smoke test aprovado NÃO conta como confiável

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: Deploy + smoke test reprovado")`

---

## Cenário combinado: Múltiplas subtarefas com data quality

**Descrição:** 6 subtarefas em estados variados, incluindo skipped e pending.

**Resultados:**

| KPI | Fórmula | Resultado |
|---|---|---|
| Escopo total | 5+3+8+2+5 = 23 (skipped excluído) | ✅ 23 |
| Avanço aceito | (5+3)/23 = 8/23 | ✅ 0.3478 |
| Progresso operacional | 4/5 elegíveis | ✅ 0.8 |
| Primeira aprovação | 1/2 verified | ✅ 0.5 |
| Retrabalho | 1/4 iniciadas | ✅ 0.25 |
| Bloqueio | 1/4 iniciadas | ✅ 0.25 |
| Weight coverage | 100% | ✅ 1.0 |

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: Cenário combinado com data quality")`

---

## Testes de integração com repositório

### AdvancementMetricsRepository com mock DB

**Cenário: dados completos**
- Mock DB retorna subtarefas, tentativas, gates e deploys
- `compute()` retorna todos os KPIs corretamente
- `acceptedAdvancement=1.0`, `gateSuccessRate=1.0`, `deployReliability=1.0`

**Cenário: dados vazios**
- Mock DB retorna vazio
- Todos os KPIs retornam `null` (não 0)
- `dataQuality.warnings` contém "Nenhuma subtarefa elegível encontrada"

**Arquivo de teste:** `test/MetricsE2E.test.ts` → `describe("E2E: AdvancementMetricsRepository com mock DB")`

---

## Testes de API HTTP

### MetricsAPI.test.ts (23 testes)

| Grupo | Testes | Status |
|---|---|---|
| GET /api/motor/metrics | 12 | ✅ |
| GET /api/motor/metrics — dados vazios | 3 | ✅ |
| GET /api/motor/metrics/tasks | 6 | ✅ |
| Compatibilidade de status legado | 2 | ✅ |

**Cobertura:**
- Todos os KPIs via HTTP
- Filtros por projectId, taskId, período
- Data quality com warnings
- Paginação na lista de tarefas
- Erro 503 quando DB indisponível
- Compatibilidade JSON pura (serializável)
- computedAt em ISO-8601

**Arquivo de teste:** `test/MetricsAPI.test.ts`

---

## Testes unitários de KPIs

### AdvancementMetrics.test.ts (39 testes)

| Função | Testes | Status |
|---|---|---|
| `computeAcceptedAdvancement` | 7 | ✅ |
| `computeOperationalProgress` | 5 | ✅ |
| `computeFirstAttemptApprovalRate` | 5 | ✅ |
| `computeReworkRate` | 4 | ✅ |
| `computeBlockerRate` | 4 | ✅ |
| `computeMedianLeadTimeSeconds` | 5 | ✅ |
| `computeGateSuccessRate` | 4 | ✅ |
| `computeDeployReliability` | 5 | ✅ |
| `computeDataQuality` | 6 | ✅ |

**Casos cobertos:**
- Denominador zero → `null` (não 0, não NaN)
- Subtarefas skipped/superseded excluídas do denominador
- Valores negativos de lead time ignorados
- Pesos nulos tratadas como 1
- Gates com/without attempt_id
- Deploys com smoke ok/fail/null

---

## Testes de normalização de status

### StatusNormalization.test.ts (24 testes)

| Função | Testes | Status |
|---|---|---|
| `normalizeTaskStatus` | 6 | ✅ |
| `normalizeSubtaskStatus` | 6 | ✅ |
| `isTerminalTaskStatus` | 4 | ✅ |
| `isTerminalSubtaskStatus` | 4 | ✅ |
| `normalizeSubtaskStatusForMetrics` | 4 | ✅ |

**Normalizações validadas:**
- `deployada` → `deployed`
- `finalizada` → `completed`
- `aborted` → `cancelled`
- Status legados nunca gravados, apenas lidos

---

## Testes de fingerprint de gate

### GateFingerprint.test.ts (15 testes)

| Função | Testes | Status |
|---|---|---|
| `computeGateFingerprint` | 8 | ✅ |
| `isRecurringFailure` | 4 | ✅ |
| `parseFingerprint` | 3 | ✅ |

**Validações:**
- Fingerprints estáveis para mesma falha
- Fingerprints diferentes para falhas diferentes
- Detecção de recorrência
- Parsing de fingerprint estruturado

---

## Testes de ciclo de vida de bloqueio

### BlockerLifecycle.test.ts (12 testes)

| Cenário | Status |
|---|---|
| Abertura e resolução de bloqueio | ✅ |
| Tempo bloqueado calculado corretamente | ✅ |
| Bloqueio sem resolução usa NOW() | ✅ |
| Múltiplos bloqueios cumulativos | ✅ |
| Categoria e severidade estruturadas | ✅ |
| Fingerprint de recorrência | ✅ |

---

## Evidência de persistência (migration)

### Migration 0026 — execution_observability.sql

**Tabelas criadas:**
- `execution_attempts` — registro de tentativas
- `execution_events` — log append-only de eventos
- `gate_runs` — registro de gates executados

**Campos adicionados:**
- `tarefas`: `deployed_at`, `smoke_test_at`, `smoke_test_ok`, `rollback_at`, `incident_id`, `customer_impact`
- `subtarefas`: `weight`, `planned_start`, `planned_end`, `estimated_effort_minutes`, `priority`, `critical_path`, `baseline_version`, `verified_at`, `superseded_by_subtask_id`
- `bloqueios`: `resolved_at`, `resolution`, `root_cause`, `category`, `severity`, `owner_id`, `recurrence_fingerprint`

**Rollback:** `migrations/0026_execution_observability.rollback.sql` — documentado e testado.

---

## Conclusão

✅ **Todos os 4 cenários E2E obrigatórios passam e deixam evidência.**

✅ **576 testes unitários e de integração passam sem regressão.**

✅ **Build TypeScript sem erros.**

✅ **Documentação completa:**
- `docs/API-METRICAS-AVANCO.md` — consumo da API
- `docs/dicionario-dados.md` — schema e catálogos
- `docs/contrato-eventos-execucao.md` — contrato de eventos
- `docs/exemplos-metricas.md` — consultas SQL e exemplos
- `docs/rollback-rollout.md` — procedimento de rollback
- `docs/EVIDENCIAS-E2E-OBSERVABILIDADE.md` — este documento

✅ **KPIs calculados corretamente:**
- Avanço aceito ponderado
- Progresso operacional
- Taxa de primeira aprovação
- Taxa de retrabalho
- Taxa de bloqueio
- Lead time mediano
- Tempo bloqueado
- Sucesso de gates
- Confiabilidade pós-deploy
- Data quality com warnings

✅ **Compatibilidade garantida:**
- Status legados normalizados em leitura
- APIs retornam JSON puro (serializável)
- `null` para dados insuficientes (nunca 0 enganoso)
