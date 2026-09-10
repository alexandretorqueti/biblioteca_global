# Runbook de Rollout — Observabilidade do Motor

> Procedimento para implantação da instrumentação de observabilidade e métricas de avanço.
> Última atualização: 2026-09-10

## Visão geral

Este runbook cobre a implantação das tabelas, índices, repositórios e endpoints de
observabilidade do Motor v2. A implementação é **aditiva** — não altera tabelas existentes
nem quebra o fluxo atual.

## Pré-requisitos

- Motor v2 rodando (container `biblioteca-global-api` com `MOTOR_VERSION=v2`)
- Acesso ao banco MySQL `projeto_640`
- Backup recente do banco (recomendado, não obrigatório)

## Passo 1: Aplicar migration

```bash
# Dentro do container da API
mysql -h <host> -u <user> -p projeto_640 < migrations/0026_execution_observability.sql
```

**Verificação:**

```sql
-- Confirmar tabelas novas
SHOW TABLES LIKE 'execution_%';
SHOW TABLES LIKE 'gate_runs';

-- Confirmar campos novos em tarefas
DESCRIBE tarefas;
-- Deve conter: deployed_at, smoke_test_at, smoke_test_ok, rollback_at, incident_id, customer_impact

-- Confirmar campos novos em subtarefas
DESCRIBE subtarefas;
-- Deve conter: weight, planned_start, planned_end, estimated_effort_minutes, priority, critical_path, baseline_version, verified_at, superseded_by_subtask_id

-- Confirmar campos novos em bloqueios
DESCRIBE bloqueios;
-- Deve conter: resolved_at, resolution, root_cause, category, severity, owner_id, recurrence_fingerprint

-- Confirmar índices
SHOW INDEX FROM execution_attempts;
SHOW INDEX FROM execution_events;
SHOW INDEX FROM gate_runs;
```

**Resultado esperado:**
- 3 tabelas novas: `execution_attempts`, `execution_events`, `gate_runs`
- Campos adicionados sem perda de dados existentes
- Índices criados para consultas por projeto, subtarefa e data

## Passo 2: Reiniciar o Motor

```bash
docker restart biblioteca-global-api
```

**Verificação:**

```bash
# Confirmar que o Motor está rodando
curl -s http://127.0.0.1:3010/api/motor/health | jq .

# Confirmar que os endpoints de métricas estão disponíveis
curl -s http://127.0.0.1:3010/api/motor/metrics | jq .
```

**Resultado esperado:**
- `health` retorna `{"ok": true, "status": "healthy"}`
- `metrics` retorna `{"ok": true, ...}` (mesmo que com dados vazios)

## Passo 3: Validar com tarefa real

Executar uma tarefa real e verificar a instrumentação:

```bash
# 1. Criar tarefa pela interface da Biblioteca
# 2. Aguardar análise e execução
# 3. Verificar métricas
curl -s "http://127.0.0.1:3010/api/motor/metrics?projectId=<id>" | jq .
```

**Verificação no banco:**

```sql
-- Confirmar tentativas registradas
SELECT * FROM execution_attempts WHERE subtask_id IN (
  SELECT id FROM subtarefas WHERE tarefa_id = <task_id>
) ORDER BY created_at DESC;

-- Confirmar eventos registrados
SELECT event_type, occurred_at, from_status, to_status
FROM execution_events
WHERE task_id = <task_id>
ORDER BY occurred_at;

-- Confirmar gates registrados
SELECT gr.gate_type, gr.status, gr.duration_ms
FROM gate_runs gr
JOIN execution_attempts ea ON ea.id = gr.attempt_id
WHERE ea.subtask_id IN (
  SELECT id FROM subtarefas WHERE tarefa_id = <task_id>
);

-- Confirmar verified_at preenchido
SELECT id, status, verified_at, weight
FROM subtarefas
WHERE tarefa_id = <task_id> AND status = 'verified';
```

**Resultado esperado:**
- `execution_attempts` com pelo menos 1 linha por subtarefa executada
- `execution_events` com eventos de `subtask_started`, `gate_passed`, `subtask_verified`
- `gate_runs` com registros de build/test/lint executados
- `verified_at` preenchido para subtarefas aceitas

## Passo 4: Validar KPIs

```bash
curl -s "http://127.0.0.1:3010/api/motor/metrics?projectId=<id>" | jq .
```

**Campos a validar:**

| Campo | Tipo | O que verificar |
|---|---|---|
| `totalWeightedScope` | number | Soma dos pesos das subtarefas elegíveis |
| `acceptedAdvancement` | number/null | 0-1 ou null se sem dados |
| `operationalProgress` | number/null | Inclui em execução |
| `firstAttemptApprovalRate` | number/null | Taxa de primeira aprovação |
| `reworkRate` | number/null | Taxa de retrabalho |
| `blockerRate` | number/null | Taxa de bloqueio |
| `medianLeadTimeSeconds` | number/null | Lead time mediano |
| `totalBlockedTimeSeconds` | number | Tempo bloqueado total |
| `gateSuccessRate` | number/null | Sucesso de gates |
| `deployReliability` | number/null | Confiabilidade pós-deploy |
| `dataQuality.warnings` | string[] | Avisos sobre dados insuficientes |

**Resultado esperado:**
- KPIs calculados corretamente para tarefas executadas
- `dataQuality.warnings` vazio se dados completos
- `null` (não 0) para KPIs sem dados suficientes

## Passo 5: Validar lista de tarefas com métricas

```bash
curl -s "http://127.0.0.1:3010/api/motor/metrics/tasks?projectId=<id>" | jq .
```

**Verificação:**

```json
{
  "ok": true,
  "pagination": { "page": 1, "pageSize": 20, "total": N, "totalPages": M },
  "tasks": [
    {
      "id": "...",
      "title": "...",
      "status": "...",
      "subtasks": { "total": N, "verified": N, "running": N, "blocked": N, "pending": N },
      "advancement": { "totalWeight": N, "acceptedWeight": N, "acceptedAdvancement": 0-1 }
    }
  ]
}
```

**Resultado esperado:**
- Lista paginada de tarefas com resumo de métricas
- `subtasks` com contagens por status
- `advancement` com pesos e avanço calculado

## Critérios de sucesso

- [ ] Migration aplicada sem erros
- [ ] Motor reiniciado e saudável
- [ ] Endpoints de métricas respondem
- [ ] Tarefa real gera tentativas, eventos e gates no banco
- [ ] KPIs calculados corretamente
- [ ] Lista de tarefas com métricas funciona
- [ ] Nenhum erro nos logs do Motor

## Rollback

Se houver problema, reverter com:

```bash
mysql -h <host> -u <user> -p projeto_640 < migrations/0026_execution_observability.rollback.sql
docker restart biblioteca-global-api
```

**O rollback:**
- Remove tabelas novas (`execution_attempts`, `execution_events`, `gate_runs`)
- Remove campos adicionados (desde que não tenham dados)
- **Não remove dados históricos** (a migration é aditiva)

Ver `docs/rollback-rollout.md` para procedimento completo de rollback do Motor v2 → v1.

## Monitoramento pós-deploy

### Logs do Motor

```bash
docker logs biblioteca-global-api | grep -E "(execution_attempt|execution_event|gate_run)"
```

### Métricas de saúde

```bash
# Health check
curl -s http://127.0.0.1:3010/api/motor/health | jq .

# Estatísticas de workers
curl -s http://127.0.0.1:3010/api/motor/stats | jq .workers
```

### Volume de dados

```sql
-- Contar registros por tabela
SELECT COUNT(*) FROM execution_attempts;
SELECT COUNT(*) FROM execution_events;
SELECT COUNT(*) FROM gate_runs;

-- Crescimento por dia
SELECT DATE(occurred_at) AS dia, COUNT(*) AS eventos
FROM execution_events
WHERE occurred_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(occurred_at)
ORDER BY dia;
```

**Alerta:** se o volume de eventos crescer >10k/dia, considerar:
- Archivar eventos antigos (>30 dias)
- Limitar `evidence_json` a 8KB (já enforced)
- Revisar granularity de eventos

## Troubleshooting

### Endpoint de métricas retorna 503

**Causa:** Banco de dados indisponível.

**Solução:**
```bash
# Verificar conexão com o banco
docker exec biblioteca-global-api mysql -h <host> -u <user> -p -e "SELECT 1"

# Verificar logs do Motor
docker logs biblioteca-global-api | grep -i "database\|mysql\|connection"
```

### KPIs retornam null

**Causa:** Dados insuficientes (denominador zero).

**Solução:** Verificar `dataQuality.warnings` na resposta. Se `weightCoverage=0`, as subtarefas não têm peso definido. Preencher pesos com:

```sql
UPDATE subtarefas SET weight = 1 WHERE weight IS NULL AND status NOT IN ('skipped');
```

### Tentativas não são registradas

**Causa:** Instrumentação não está ativa (Motor antigo).

**Solução:** Confirmar que o Motor foi reiniciado após a migration:
```bash
docker restart biblioteca-global-api
```

### Gates não são registrados

**Causa:** Gates não estão sendo executados ou a instrumentação não está ativa.

**Solução:** Verificar se o `TaskCoordinator` está chamando `runTaskIntegrationGate` e se o `GateFingerprint` está sendo computado.

## Referências

- Migration: `migrations/0026_execution_observability.sql`
- Rollback: `migrations/0026_execution_observability.rollback.sql`
- API: `docs/API-METRICAS-AVANCO.md`
- Dicionário: `docs/dicionario-dados.md`
- Evidências: `docs/EVIDENCIAS-E2E-OBSERVABILIDADE.md`
- Código: `motor-v2/src/metrics/AdvancementMetrics.ts`
- Código: `motor-v2/src/api/MotorAPI.ts`
