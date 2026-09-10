# API de Métricas de Avanço do Motor

> Documento de consumo da API de observabilidade e métricas do Motor v2.
> Última atualização: 2026-09-10.

## Visão geral

O Motor expõe dois endpoints de métricas para dashboard, gestão e integração:

| Endpoint | Método | Descrição |
|---|---|---|
| `/api/motor/metrics` | GET | KPIs consolidados de avanço |
| `/api/motor/metrics/tasks` | GET | Lista de tarefas com resumo de métricas |

Ambos retornam JSON com `ok: true` em caso de sucesso ou `ok: false` com `error` em caso de falha.

---

## GET /api/motor/metrics

Retorna todos os indicadores de avanço do Motor para um filtro opcional.

### Query params

| Parâmetro | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `projectId` | number | não | Filtra por ID do projeto |
| `taskId` | number | não | Filtra por ID da tarefa |
| `from` | ISO-8601 | não | Início do período (ex.: `2026-09-01T00:00:00Z`) |
| `to` | ISO-8601 | não | Fim do período (ex.: `2026-09-30T23:59:59Z`) |

### Exemplo de requisição

```
GET /api/motor/metrics?projectId=640&from=2026-09-01T00:00:00Z&to=2026-09-30T23:59:59Z
```

### Resposta

```json
{
  "ok": true,
  "totalWeightedScope": 23,
  "acceptedAdvancement": 0.348,
  "operationalProgress": 0.8,
  "blockedItems": 1,
  "firstAttemptApprovalRate": 0.5,
  "reworkRate": 0.25,
  "blockerRate": 0.25,
  "medianLeadTimeSeconds": 5400,
  "totalBlockedTimeSeconds": 1800,
  "gateSuccessRate": 0.75,
  "deployReliability": 1.0,
  "dataQuality": {
    "weightCoverage": 1.0,
    "deadlineCoverage": 0.6,
    "durationCoverage": 0.5,
    "gateCoverage": 0.5,
    "warnings": [
      "Cobertura de prazos baixa (60%). Lead time planejado não pode ser calculado."
    ]
  },
  "filter": {
    "projectId": 640,
    "taskId": null,
    "from": "2026-09-01T00:00:00.000Z",
    "to": "2026-09-30T23:59:59.000Z"
  },
  "computedAt": "2026-09-10T20:00:00.000Z"
}
```

### Dicionário de campos

| Campo | Tipo | Descrição |
|---|---|---|
| `totalWeightedScope` | number | Soma dos pesos das subtarefas elegíveis |
| `acceptedAdvancement` | number \| null | Avanço aceito ponderado (0-1). Null se denominador = 0 |
| `operationalProgress` | number \| null | Progresso operacional (0-1). Inclui em execução. Null se sem dados |
| `blockedItems` | number | Quantidade de subtarefas com status `blocked` |
| `firstAttemptApprovalRate` | number \| null | Taxa de aprovação na 1ª tentativa (0-1). Null se sem verified |
| `reworkRate` | number \| null | Taxa de retrabalho (0-1). Null se sem iniciadas |
| `blockerRate` | number \| null | Taxa de bloqueio (0-1). Null se sem iniciadas |
| `medianLeadTimeSeconds` | number \| null | Lead time mediano em segundos. Null se sem verified |
| `totalBlockedTimeSeconds` | number | Soma do tempo bloqueado (abertura → resolução ou agora) |
| `gateSuccessRate` | number \| null | Taxa de sucesso de gates (0-1). Null se sem gates |
| `deployReliability` | number \| null | Confiabilidade pós-deploy (0-1). Null se sem deploys |
| `dataQuality` | object | Qualidade dos dados usados no cálculo |
| `dataQuality.weightCoverage` | number | % de subtarefas com peso definido (0-1) |
| `dataQuality.deadlineCoverage` | number | % de subtarefas com prazo planejado (0-1) |
| `dataQuality.durationCoverage` | number | % de tentativas com duração preenchida (0-1) |
| `dataQuality.gateCoverage` | number | % de tentativas com gates registrados (0-1) |
| `dataQuality.warnings` | string[] | Avisos sobre dados insuficientes |
| `filter` | object | Filtro aplicado (espelho dos params) |
| `computedAt` | string | Timestamp ISO-8601 do cálculo |

### Diferenciação: aceito vs operacional

- **`acceptedAdvancement`**: conta SOMENTE subtarefas `verified` ou `completed`. Representa trabalho tecnicamente aceito.
- **`operationalProgress`**: conta `verified`, `completed`, `running`, `delivered`, `verifying`, `blocked`, `rejected`, `failed`, `rework`. Representa trabalho em andamento ou finalizado, independente de aceite técnico.

> ⚠️ **Regra**: se o denominador for 0 ou os dados mínimos estiverem ausentes, o campo retorna `null` (não 0). Consulte `dataQuality.warnings` para entender o motivo.

---

## GET /api/motor/metrics/tasks

Retorna lista paginada de tarefas com resumo de métricas por tarefa.

### Query params

| Parâmetro | Tipo | Obrigatório | Default | Descrição |
|---|---|---|---|---|
| `projectId` | number | não | — | Filtra por projeto |
| `from` | ISO-8601 | não | — | Início do período |
| `to` | ISO-8601 | não | — | Fim do período |
| `page` | number | não | 1 | Página (mín 1) |
| `pageSize` | number | não | 20 | Itens por página (1-100) |

### Exemplo de requisição

```
GET /api/motor/metrics/tasks?projectId=640&page=1&pageSize=10
```

### Resposta

```json
{
  "ok": true,
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 42,
    "totalPages": 5
  },
  "tasks": [
    {
      "id": "780",
      "title": "Instrumentar observabilidade e métricas",
      "status": "running",
      "projectId": 640,
      "createdAt": "2026-09-08T10:00:00.000Z",
      "completedAt": null,
      "subtasks": {
        "total": 7,
        "verified": 5,
        "running": 1,
        "blocked": 0,
        "pending": 1
      },
      "advancement": {
        "totalWeight": 34,
        "acceptedWeight": 21,
        "acceptedAdvancement": 0.618,
        "operationalProgress": 0.857
      }
    }
  ]
}
```

### Dicionário de campos (task)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string | ID da tarefa |
| `title` | string | Título |
| `status` | string | Status canônico (normalizado) |
| `projectId` | number | ID do projeto |
| `createdAt` | string | ISO-8601 da criação |
| `completedAt` | string \| null | ISO-8601 da conclusão |
| `subtasks.total` | number | Total de subtarefas elegíveis |
| `subtasks.verified` | number | Subtarefas verified/completed |
| `subtasks.running` | number | Subtarefas em execução (running, delivered, verifying, rework) |
| `subtasks.blocked` | number | Subtarefas bloqueadas |
| `subtasks.pending` | number | Subtarefas pendentes |
| `advancement.totalWeight` | number | Soma dos pesos |
| `advancement.acceptedWeight` | number | Soma dos pesos aceitos |
| `advancement.acceptedAdvancement` | number \| null | Peso aceito / peso total |
| `advancement.operationalProgress` | number \| null | (verified + running + blocked) / total |

---

## Códigos de erro

| HTTP | Significado |
|---|---|
| 200 | Sucesso |
| 404 | Endpoint não encontrado |
| 500 | Erro interno (ver `error`) |
| 503 | Banco de dados indisponível |

---

## Interpretação dos KPIs

### Avanço aceito ponderado

```
acceptedAdvancement = Σ(peso × [status ∈ {verified, completed}]) / Σ(pesos elegíveis)
```

- **Elegíveis**: todas exceto `skipped` e `superseded` com sucessora.
- **Peso default**: 1 quando não definido.
- **Escala recomendada**: 1, 2, 3, 5, 8 (Fibonacci simplificado).

### Progresso operacional

```
operationalProgress = (verified + completed + running + delivered + verifying + blocked + rejected + failed + rework) / elegíveis
```

> Inclui trabalho em andamento. NÃO é aceite técnico.

### Lead time mediano

Mediana de `verified_at - created_at` das subtarefas verified. Ignora valores negativos.

### Confiabilidade pós-deploy

```
deployReliability = deploys_com_smoke_ok / deploys_com_deployed_at
```

- Deploy SEM smoke test aprovado → NÃO é confiável.
- `smoke_test_ok = null` → não verificado, conta como não confiável.

---

## Exemplos de uso

### cURL

```bash
# KPIs globais
curl http://localhost:3010/api/motor/metrics

# KPIs do projeto 640 em setembro
curl "http://localhost:3010/api/motor/metrics?projectId=640&from=2026-09-01T00:00:00Z&to=2026-09-30T23:59:59Z"

# Lista de tarefas com métricas
curl "http://localhost:3010/api/motor/metrics/tasks?projectId=640&page=1&pageSize=10"
```

### JavaScript/TypeScript

```typescript
const response = await fetch('http://localhost:3010/api/motor/metrics?projectId=640')
const data = await response.json()

if (data.ok) {
  console.log(`Avanço aceito: ${(data.acceptedAdvancement! * 100).toFixed(1)}%`)
  console.log(`Progresso operacional: ${(data.operationalProgress! * 100).toFixed(1)}%`)
  console.log(`Lead time mediano: ${(data.medianLeadTimeSeconds! / 3600).toFixed(1)}h`)

  if (data.dataQuality.warnings.length > 0) {
    console.warn('Avisos:', data.dataQuality.warnings)
  }
}
```

---

## Compatibilidade

- Status legados (`deployada`, `finalizada`, `aborted`) são normalizados em tempo de leitura.
- APIs retornam apenas status canônicos.
- Campos `null` indicam dados insuficientes — nunca 0 enganoso.
- Resposta é JSON puro (serializável, sem tipos especiais).
