# Dicionário de Dados — Observabilidade do Motor

## Tabelas novas (migration aditiva)

### `execution_attempts`

Registro de cada tentativa de execução de uma subtarefa.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | BIGINT PK AUTO_INCREMENT | Identificador único da tentativa |
| `subtask_id` | BIGINT NOT NULL | FK → `subtarefas.id` |
| `attempt_number` | INT NOT NULL | Número sequencial (1 = primeira) |
| `started_at` | DATETIME(6) NOT NULL | Início da execução |
| `finished_at` | DATETIME(6) NULL | Fim da execução (null = em curso) |
| `outcome` | VARCHAR(50) NOT NULL | `verified`, `rejected`, `blocked`, `cancelled`, `error` |
| `rework_reason` | VARCHAR(500) NULL | Motivo do retrabalho (se aplicável) |
| `agent_id` | VARCHAR(100) NULL | Agente que executou |
| `model` | VARCHAR(100) NULL | Modelo usado |
| `execution_id` | VARCHAR(100) NULL | ID da execução do Motor |
| `workspace_path` | VARCHAR(500) NULL | Caminho do worktree |
| `base_commit` | VARCHAR(40) NULL | Commit base antes da execução |
| `result_commit` | VARCHAR(40) NULL | Commit resultante |
| `token_input` | INT NULL | Tokens de entrada |
| `token_output` | INT NULL | Tokens de saída |
| `cost_usd` | DECIMAL(10,6) NULL | Custo estimado em USD |
| `created_at` | DATETIME(6) NOT NULL DEFAULT NOW() | Registro da linha |

**Índices:** `idx_attempt_subtask (subtask_id)`, `idx_attempt_execution (execution_id)`

### `execution_events`

Log append-only de todos os eventos de execução.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | BIGINT PK AUTO_INCREMENT | PK interna |
| `event_id` | VARCHAR(36) NOT NULL UNIQUE | UUID do evento |
| `occurred_at` | DATETIME(6) NOT NULL | Instante do fato |
| `task_id` | BIGINT NOT NULL | FK → `tarefas.id` |
| `subtask_id` | BIGINT NULL | FK → `subtarefas.id` |
| `attempt_id` | BIGINT NULL | FK → `execution_attempts.id` |
| `event_type` | VARCHAR(50) NOT NULL | Ver catálogo abaixo |
| `from_status` | VARCHAR(50) NULL | Status anterior (transições) |
| `to_status` | VARCHAR(50) NULL | Status posterior (transições) |
| `actor_type` | VARCHAR(20) NOT NULL | `motor`, `agent`, `human`, `system` |
| `agent_id` | VARCHAR(100) NULL | Agente responsável |
| `model` | VARCHAR(100) NULL | Modelo usado |
| `execution_id` | VARCHAR(100) NULL | Execução do Motor |
| `workspace_commit` | VARCHAR(40) NULL | Commit no momento do evento |
| `reason_code` | VARCHAR(50) NULL | Código do motivo (ver catálogo) |
| `correlation_id` | VARCHAR(100) NOT NULL | Agrupa eventos de uma operação |

**Índices:** `idx_event_subtask (subtask_id)`, `idx_event_attempt (attempt_id)`, `idx_event_occurred (occurred_at)`, `idx_event_type (event_type)`, `idx_event_correlation (correlation_id)`

### `gate_runs`

Registro de cada gate técnico executado.

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | BIGINT PK AUTO_INCREMENT | PK interna |
| `attempt_id` | BIGINT NOT NULL | FK → `execution_attempts.id` |
| `gate_type` | VARCHAR(50) NOT NULL | `build`, `test`, `lint`, `integration`, `e2e`, `security`, `smoke_test` |
| `command` | VARCHAR(1000) NULL | Comando executado (sanitizado) |
| `started_at` | DATETIME(6) NOT NULL | Início do gate |
| `finished_at` | DATETIME(6) NULL | Fim do gate |
| `duration_ms` | INT NULL | Duração em milissegundos |
| `exit_code` | INT NULL | Código de saída do processo |
| `status` | VARCHAR(20) NOT NULL | `passed`, `failed`, `timeout`, `skipped` |
| `failure_fingerprint` | VARCHAR(255) NULL | Hash estável para falhas recorrentes |
| `evidence_json` | JSON NULL | Evidência sanitizada (max 8KB) |

**Índices:** `idx_gate_attempt (attempt_id)`, `idx_gate_type_status (gate_type, status)`

### Campos adicionados a `tarefas`

| Coluna | Tipo | Descrição |
|---|---|---|
| `deployed_at` | DATETIME(6) NULL | Quando o deploy terminou com sucesso |
| `smoke_test_at` | DATETIME(6) NULL | Quando o smoke test foi executado |
| `smoke_test_ok` | BOOLEAN NULL | Resultado do smoke test (null = não verificado) |
| `rollback_at` | DATETIME(6) NULL | Quando houve rollback |
| `incident_id` | VARCHAR(100) NULL | ID do incidente relacionado |
| `customer_impact` | BOOLEAN NULL | Se impactou clientes |

### Campos adicionados a `subtarefas`

| Coluna | Tipo | Descrição |
|---|---|---|
| `weight` | INT NULL | Peso do escopo (escala 1,2,3,5,8) |
| `planned_start` | DATETIME(6) NULL | Início planejado |
| `planned_end` | DATETIME(6) NULL | Fim planejado |
| `estimated_effort_minutes` | INT NULL | Esforço estimado em minutos |
| `priority` | INT NULL | Prioridade (1=alta) |
| `critical_path` | BOOLEAN NULL | Se está no caminho crítico |
| `baseline_version` | VARCHAR(40) NULL | Versão baseline |
| `verified_at` | DATETIME(6) NULL | Quando foi aceita tecnicamente |
| `superseded_by_subtask_id` | BIGINT NULL | FK para subtarefa sucessora |

### Campos adicionados a `bloqueios` (migration 0026)

| Coluna | Tipo | Descrição |
|---|---|---|
| `resolved_at` | DATETIME(6) NULL | Quando foi resolvido |
| `resolution` | TEXT NULL | Descrição da resolução |
| `root_cause` | VARCHAR(500) NULL | Causa-raiz identificada |
| `category` | VARCHAR(100) NULL | Categoria (environment, dependency, etc.) |
| `severity` | VARCHAR(20) NULL | `low`, `medium`, `high`, `critical` |
| `owner_id` | VARCHAR(100) NULL | Responsável pela resolução |
| `recurrence_fingerprint` | VARCHAR(255) NULL | Hash para detectar recorrência |

## Catálogo de eventos (`event_type`)

| Grupo | Evento | Significado |
|---|---|---|
| Tarefa | `task_started` | Tarefa iniciou execução |
| Tarefa | `task_paused` | Tarefa pausada |
| Tarefa | `task_resumed` | Tarefa retomada |
| Tarefa | `task_failed` | Tarefa falhou |
| Tarefa | `task_completed` | Tarefa concluída |
| Tarefa | `execution_cancelled` | Execução cancelada |
| Tarefa | `execution_error` | Erro sistêmico na execução |
| Subtarefa | `subtask_started` | Subtarefa iniciou |
| Subtarefa | `subtask_retried` | Subtarefa em retry |
| Subtarefa | `subtask_delivered` | Entrega submetida a gate |
| Subtarefa | `subtask_verified` | Aceite técnico |
| Subtarefa | `subtask_rejected` | Entrega rejeitada |
| Subtarefa | `subtask_blocked` | Subtarefa bloqueada |
| Subtarefa | `subtask_superseded` | Substituída por revisão |
| Gate | `gate_started` | Gate iniciou execução |
| Gate | `gate_passed` | Gate aprovou |
| Gate | `gate_failed` | Gate reprovou |
| Bloqueio | `blocker_opened` | Bloqueio aberto |
| Bloqueio | `blocker_resolved` | Bloqueio resolvido |
| Integração | `integration_conflict` | Conflito de merge |
| Deploy | `deploy_requested` | Deploy solicitado |
| Deploy | `deploy_started` | Deploy em execução |
| Deploy | `deploy_succeeded` | Deploy com sucesso |
| Deploy | `deploy_failed` | Deploy falhou |
| Pós-deploy | `smoke_test_passed` | Smoke test aprovou |
| Pós-deploy | `smoke_test_failed` | Smoke test reprovou |

## Catálogo de `reason_code`

| Código | Significado |
|---|---|
| `manual` | Ação manual |
| `worker_started` | Worker iniciou |
| `retry_after_rejection` | Retry após rejeição |
| `gate_passed` | Gate aprovou |
| `gate_failed` | Gate reprovou |
| `blocked_environment` | Ambiente bloqueado |
| `systemic_failure` | Falha sistêmica |
| `model_chain_exhausted` | Cadeia de modelos esgotada |
| `correction_failed` | Correção falhou |
| `integration_conflict` | Conflito de integração |
| `timeout` | Timeout |
| `lease_lost` | Lease perdido |
| `lease_expired` | Lease expirado |
| `cancelled` | Cancelado |
| `paused` | Pausado |
| `resumed` | Retomado |
| `deploy_requested` | Deploy solicitado |
| `deploy_succeeded` | Deploy com sucesso |
| `deploy_failed` | Deploy falhou |
| `smoke_test_passed` | Smoke test aprovou |
| `smoke_test_failed` | Smoke test reprovou |
| `invalid_transition` | Transição inválida |

## Catálogo de `gate_type`

| Tipo | Descrição |
|---|---|
| `build` | Compilação do projeto |
| `test` | Testes unitários |
| `integration` | Testes de integração |
| `e2e` | Testes end-to-end |
| `lint` | Análise estática / lint |
| `security` | Varredura de segurança |
| `smoke_test` | Smoke test pós-deploy |

## Estados canônicos

### Tarefa

`draft`, `planned`, `analyzing`, `awaiting_clarification`, `ready`, `running`, `paused`, `completed`, `deployed`, `blocked`, `motor_fix`, `failed`, `cancelled`

Legados (leitura apenas): `finalizada`, `deployada`, `aborted`

### Subtarefa

`pending`, `delivered`, `running`, `verifying`, `verified`, `rejected`, `blocked`, `completed`, `failed`, `skipped`, `rework`, `superseded`

## Regras de normalização

- `deployada` → `deployed` (em leituras)
- `finalizada` → `completed` (em leituras)
- `aborted` → `cancelled` (em leituras)
- Novas gravações NUNCA usam status legados
- `superseded` é excluído do denominador SOMENTE quando a sucessora existe
