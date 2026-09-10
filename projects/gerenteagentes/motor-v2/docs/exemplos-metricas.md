# Exemplos de Consumo — Métricas de Avanço do Motor

## API de Métricas (via `AdvancementMetricsRepository`)

### Uso básico em código

```typescript
import { AdvancementMetricsRepository } from "./motor-v2/src/metrics/AdvancementMetrics.js"

const repo = new AdvancementMetricsRepository(db)

// Métricas de um projeto específico
const metrics = await repo.compute({ projectId: 640 })

console.log("Avanço aceito:", metrics.acceptedAdvancement)      // 0-1 ou null
console.log("Progresso operacional:", metrics.operationalProgress) // 0-1 ou null
console.log("Lead time mediano:", metrics.medianLeadTimeSeconds)   // segundos ou null
console.log("Avisos:", metrics.dataQuality.warnings)
```

### Filtros disponíveis

```typescript
interface MetricsFilter {
  projectId?: number   // Filtrar por projeto
  taskId?: number      // Filtrar por tarefa
  from?: Date          // Início do período
  to?: Date            // Fim do período
}

// Por tarefa específica
const taskMetrics = await repo.compute({ taskId: 727 })

// Por período
const periodMetrics = await repo.compute({
  projectId: 640,
  from: new Date("2026-09-01"),
  to: new Date("2026-09-30"),
})
```

### Interpretação da resposta

```typescript
interface AdvancementMetricsResult {
  totalWeightedScope: number          // Escopo total (soma dos pesos)
  acceptedAdvancement: number | null  // 0-1 (null = dados insuficientes)
  operationalProgress: number | null  // 0-1 (inclui em execução)
  blockedItems: number                // Contagem de itens bloqueados
  firstAttemptApprovalRate: number | null  // 0-1
  reworkRate: number | null           // 0-1
  blockerRate: number | null          // 0-1
  medianLeadTimeSeconds: number | null // Mediana em segundos
  totalBlockedTimeSeconds: number     // Tempo bloqueado total
  gateSuccessRate: number | null      // 0-1
  deployReliability: number | null    // 0-1
  dataQuality: DataQuality            // Cobertura e avisos
  filter: MetricsFilter               // Filtro aplicado
  computedAt: Date                    // Quando foi calculado
}
```

## Consultas SQL diretas

### Avanço aceito ponderado por projeto

```sql
SELECT
  t.projeto_id,
  SUM(COALESCE(s.weight, 1)) AS total_weight,
  SUM(CASE WHEN s.status IN ('verified', 'completed') THEN COALESCE(s.weight, 1) ELSE 0 END) AS accepted_weight,
  SUM(CASE WHEN s.status IN ('verified', 'completed') THEN COALESCE(s.weight, 1) ELSE 0 END)
    / SUM(COALESCE(s.weight, 1)) AS accepted_advancement
FROM subtarefas s
JOIN tarefas t ON t.id = s.tarefa_id
WHERE s.status NOT IN ('skipped')
  AND NOT (s.status = 'superseded' AND s.superseded_by_subtask_id IS NOT NULL)
  AND t.projeto_id = 640
GROUP BY t.projeto_id;
```

### Taxa de primeira aprovação

```sql
SELECT
  COUNT(*) AS verified_count,
  SUM(CASE WHEN ea_min.attempt_number = 1 THEN 1 ELSE 0 END) AS first_attempt_count,
  SUM(CASE WHEN ea_min.attempt_number = 1 THEN 1 ELSE 0 END) / COUNT(*) AS first_approval_rate
FROM subtarefas s
JOIN (
  SELECT subtask_id, MIN(attempt_number) AS attempt_number
  FROM execution_attempts
  WHERE outcome IN ('verified', 'completed')
  GROUP BY subtask_id
) ea_min ON ea_min.subtask_id = s.id
WHERE s.status IN ('verified', 'completed');
```

### Taxa de retrabalho

```sql
SELECT
  COUNT(*) AS started_count,
  SUM(CASE WHEN attempt_count > 1 THEN 1 ELSE 0 END) AS rework_count,
  SUM(CASE WHEN attempt_count > 1 THEN 1 ELSE 0 END) / COUNT(*) AS rework_rate
FROM (
  SELECT s.id, COUNT(ea.id) AS attempt_count
  FROM subtarefas s
  JOIN execution_attempts ea ON ea.subtask_id = s.id
  GROUP BY s.id
  HAVING attempt_count > 0
) subtasks_with_attempts;
```

### Lead time mediano

```sql
-- MySQL não tem MEDIANA nativa; usar subquery com LIMIT/OFFSET
SELECT AVG(lead_time_seconds) AS median_lead_time
FROM (
  SELECT TIMESTAMPDIFF(SECOND, s.created_at, s.verified_at) AS lead_time_seconds
  FROM subtarefas s
  WHERE s.status IN ('verified', 'completed')
    AND s.verified_at IS NOT NULL
  ORDER BY lead_time_seconds
  LIMIT 1
  OFFSET (SELECT COUNT(*) DIV 2 FROM subtarefas WHERE status IN ('verified', 'completed') AND verified_at IS NOT NULL)
) median_calc;
```

### Tempo bloqueado por tarefa

```sql
SELECT
  b.tarefa_id,
  SUM(TIMESTAMPDIFF(SECOND, b.blocked_at, COALESCE(b.resolved_at, NOW()))) AS total_blocked_seconds
FROM bloqueios b
WHERE b.tarefa_id = 727
GROUP BY b.tarefa_id;
```

### Sucesso de gates por tipo

```sql
SELECT
  gr.gate_type,
  COUNT(*) AS total,
  SUM(CASE WHEN gr.status = 'passed' THEN 1 ELSE 0 END) AS passed,
  SUM(CASE WHEN gr.status = 'passed' THEN 1 ELSE 0 END) / COUNT(*) AS success_rate
FROM gate_runs gr
JOIN execution_attempts ea ON ea.id = gr.attempt_id
JOIN subtarefas s ON s.id = ea.subtask_id
JOIN tarefas t ON t.id = s.tarefa_id
WHERE t.projeto_id = 640
GROUP BY gr.gate_type;
```

### Confiabilidade pós-deploy

```sql
SELECT
  COUNT(*) AS total_deploys,
  SUM(CASE WHEN smoke_test_ok = TRUE THEN 1 ELSE 0 END) AS reliable_deploys,
  SUM(CASE WHEN smoke_test_ok = TRUE THEN 1 ELSE 0 END) / COUNT(*) AS deploy_reliability
FROM tarefas
WHERE deployed_at IS NOT NULL
  AND projeto_id = 640;
```

### Qualidade de dados

```sql
-- Cobertura de pesos
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN weight IS NOT NULL THEN 1 ELSE 0 END) AS with_weight,
  SUM(CASE WHEN weight IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*) AS weight_coverage
FROM subtarefas
WHERE status NOT IN ('skipped');

-- Cobertura de prazos
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN planned_start IS NOT NULL AND planned_end IS NOT NULL THEN 1 ELSE 0 END) AS with_deadline,
  SUM(CASE WHEN planned_start IS NOT NULL AND planned_end IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*) AS deadline_coverage
FROM subtarefas
WHERE status NOT IN ('skipped');
```

## Exemplo de resposta da API

```json
{
  "totalWeightedScope": 23,
  "acceptedAdvancement": 0.3478,
  "operationalProgress": 0.8,
  "blockedItems": 1,
  "firstAttemptApprovalRate": 0.5,
  "reworkRate": 0.25,
  "blockerRate": 0.25,
  "medianLeadTimeSeconds": 5400,
  "totalBlockedTimeSeconds": 1800,
  "gateSuccessRate": 0.85,
  "deployReliability": 0.67,
  "dataQuality": {
    "weightCoverage": 1.0,
    "deadlineCoverage": 0.6,
    "durationCoverage": 0.9,
    "gateCoverage": 0.8,
    "warnings": [
      "Cobertura de prazos baixa (60%). Lead time planejado não pode ser calculado."
    ]
  },
  "filter": { "projectId": 640 },
  "computedAt": "2026-09-10T17:00:00.000Z"
}
```

## Regras de interpretação

1. **`null` ≠ 0**: quando um KPI retorna `null`, significa dados insuficientes, não zero.
2. **Avanço aceito ≠ progresso operacional**: aceito é o que passou pelo gate; operacional inclui em execução.
3. **Confiabilidade pós-deploy independente**: uma subtarefa pode estar `verified` (aceite técnico) mas o deploy não ser confiável (smoke reprovado).
4. **Avisos de qualidade**: se `dataQuality.warnings` não está vazio, os KPIs podem ser imprecisos.
5. **Denominador zero**: quando não há subtarefas elegíveis, todos os KPIs retornam `null`.
