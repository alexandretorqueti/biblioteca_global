# Reconciliador de Sessões Órfãs sem Claim

**Status:** Implementado  
**Data:** 2026-09-25  
**Contexto:** Tarefa 873 — incidente com sessões de análise em limbo após restart

## Problema

Quando o motor é reiniciado abruptamente (ex.: deploy blue-green), as sessões de análise marcadas como `active` no `analyst_task_sessions` podem ficar órfãs porque o `task_runtime_facts.analysis_started_at` é liberado pelo `AnalysisClaimReconciler` no boot.

O `AnalysisSessionRecoveryReconciler` original só buscava sessões onde `f.analysis_started_at IS NOT NULL`, então não encontrava essas sessões órfãs. Evidência: tarefa 873 tinha 2 sessões `active` (IDs 195 e 197) mas `analysis_started_at = NULL`, presa em limbo.

## Solução

Adicionada uma segunda query ao `AnalysisSessionRecoveryReconciler.reconcileOnce()` que detecta sessões órfãs sem claim correspondente.

### Critérios de Sessão Órfã

Uma sessão é considerada órfã quando TODAS as condições abaixo são verdadeiras:

1. `status = 'active'` — sessão ainda não foi fechada
2. **E** uma das seguintes:
   - `f.analysis_started_at IS NULL` — claim foi liberado (restart do motor)
   - `f.analysis_execution_id != s.analysis_execution_id` — execution_id divergente (claim substituído por tentativa posterior)
3. `s.opened_at < NOW() - INTERVAL 10 MINUTE` — margem para evitar race com análise em andamento

### Query

```sql
SELECT s.id AS session_id, s.tarefa_id, t.external_id AS task_external_id,
       s.analysis_execution_id
  FROM analyst_task_sessions s
  INNER JOIN tarefas t ON t.id = s.tarefa_id
  LEFT JOIN task_runtime_facts f ON f.tarefa_id = s.tarefa_id
 WHERE s.status = 'active'
   AND (f.analysis_started_at IS NULL OR f.analysis_execution_id != s.analysis_execution_id)
   AND s.opened_at < NOW() - INTERVAL 10 MINUTE
 ORDER BY s.tarefa_id ASC, s.opened_at ASC
```

## Fluxo de Recuperação

Para cada sessão órfã detectada:

### 1. Marcar Sessão como Failed

```sql
UPDATE analyst_task_sessions
   SET status='failed',
       close_reason='orphaned_by_restart',
       closed_at=NOW(),
       last_activity_at=NOW()
 WHERE id=? AND status='active'
```

### 2. Registrar Evento de Auditoria

Evento `analysis_session_orphaned` registrado via `TaskEventSink`:

```typescript
await taskEvents.record(taskId, 'analysis_session_orphaned', 'motor', {
  sessionId: number,
  tarefaId: number,
  executionId: string | null,
  closeReason: 'orphaned_by_restart',
})
```

### 3. Verificar Condições para Reanálise

A tarefa só será reanalisada automaticamente se:

- ✅ `subtaskCount === 0` — não tem subtarefas em andamento
- ✅ `terminal === false` — não está em status terminal (completed/failed/cancelled)
- ✅ `paused === false` — não está pausada

### 4. Disparar TASK_RESUME_REQUESTED

Se todas as condições acima forem satisfeitas, o callback `publishTaskResume` é invocado:

```typescript
await publishTaskResume(taskId, executionId)
```

O callback injetado em `start.ts` faz enqueue de `TASK_RESUME_REQUESTED` no outbox:

```typescript
publishTaskResume: async (taskId, executionId) => {
  await outboxPublisher.enqueue(createQueueMessage({
    type: 'TASK_RESUME_REQUESTED',
    taskId,
    executionId,
    payload: { reason: 'orphaned_session_cleanup' },
  }))
}
```

### 5. Registrar Evento de Resume

Evento `analysis_orphan_resume_requested` registrado para auditoria:

```typescript
await taskEvents.record(taskId, 'analysis_orphan_resume_requested', 'motor', {
  sessionId: number,
  executionId: string,
})
```

## Interface e Configuração

### Nova Interface

```typescript
export interface OrphanSessionRow extends RowDataPacket {
  session_id: number
  tarefa_id: number
  task_external_id: string | null
  analysis_execution_id: string | null
}
```

### Extensão do Config

```typescript
export interface AnalysisSessionRecoveryConfig {
  publishTaskReady: (taskId: string, executionId: string, subtaskCount: number) => Promise<void>
  publishTaskResume?: (taskId: string, executionId: string) => Promise<void>
  taskEvents?: TaskEventSink
  intervalMs?: number
  leaseTtlMs?: number
}
```

## Método `reconcileOrphanSessions()`

Adicionado ao `AnalysisSessionRecoveryReconciler`:

- Chamado ao final de `reconcileOnce()` após o reconciliador de sessões com claim
- Processa sessões órfãs em ordem (tarefa_id ASC, opened_at ASC)
- Falha no tratamento de uma sessão não impede o processamento das demais
- Log de erro para cada falha individual

## Testes Unitários

Dois cenários cobertos em `motor-v3/test/analysis-session-recovery-reconciler.test.ts`:

### 1. Limpa sessão órfã sem claim e dispara reanálise

- Simula sessão `active` com `analysis_started_at IS NULL`
- Valida que sessão é marcada como `failed` com `close_reason='orphaned_by_restart'`
- Valida que evento `analysis_session_orphaned` é registrado
- Valida que `publishTaskResume` é chamado (tarefa sem subtarefas)
- Valida que evento `analysis_orphan_resume_requested` é registrado

### 2. Não dispara reanálise quando tarefa tem subtarefas

- Simula sessão órfã para tarefa com `subtaskCount > 0`
- Valida que sessão é marcada como `failed`
- Valida que `publishTaskResume` **NÃO** é chamado

## Relação com Outros Reconciliadores

### AnalysisClaimReconciler

- Roda no boot e libera claims órfãos (`analysis_started_at IS NOT NULL` sem sessão ativa correspondente)
- **Não** limpa sessões órfãs (sessões `active` sem claim)
- Complementar ao `reconcileOrphanSessions()`

### AnalysisSessionRecoveryReconciler (original)

- Recupera sessões `active` **com** claim válido (`analysis_started_at IS NOT NULL` e `execution_id` correspondente)
- Tenta retomar a análise na mesma sessão do Console
- **Não** trata sessões sem claim

### AnalysisSessionRecoveryReconciler (estendido)

- Mantém o comportamento original
- Adiciona `reconcileOrphanSessions()` para limpar sessões sem claim
- Dispara reanálise automática quando possível

## Ordem de Execução no Boot

1. `AnalysisClaimReconciler.reconcile()` — libera claims órfãos
2. `AnalysisSessionRecoveryReconciler.reconcile()` — primeira passagem:
   - Recupera sessões com claim válido
   - Limpa sessões órfãs sem claim (novo)
3. `AnalysisSessionRecoveryReconciler.start()` — inicia timer periódico

## Cenários de Recuperação

### Cenário 1: Restart durante análise (claim liberado)

1. Motor está executando análise da tarefa 873
2. Sessão `active` criada com `analysis_execution_id='exec-873'`
3. Motor reinicia abruptamente
4. Boot: `AnalysisClaimReconciler` libera claim (`analysis_started_at = NULL`)
5. `reconcileOrphanSessions()` detecta sessão órfã (opened_at > 10min)
6. Sessão marcada como `failed` com `close_reason='orphaned_by_restart'`
7. `TASK_RESUME_REQUESTED` disparado (se tarefa sem subtarefas)
8. Tarefa volta para análise automaticamente

### Cenário 2: Claim substituído por tentativa posterior

1. Tarefa 873 tem sessão `active` com `execution_id='exec-873-v1'`
2. Nova tentativa de análise cria claim com `execution_id='exec-873-v2'`
3. Sessão antiga fica órfã (execution_id divergente)
4. Após 10 minutos, `reconcileOrphanSessions()` detecta e limpa
5. Sessão antiga marcada como `failed`

### Cenário 3: Tarefa com subtarefas em andamento

1. Tarefa 874 tem sessão órfã mas já possui 3 subtarefas em execução
2. `reconcileOrphanSessions()` detecta sessão órfã
3. Sessão marcada como `failed`
4. `TASK_RESUME_REQUESTED` **NÃO** é disparado (subtaskCount > 0)
5. Tarefa continua execução normal das subtarefas

## Observabilidade

### Eventos Registrados

- `analysis_session_orphaned` — sessão órfã detectada e limpa
- `analysis_orphan_resume_requested` — reanálise automática disparada

### Logs

- `[Motor v3] Falha ao limpar sessão órfã {session_id} para task={task_id}: {error}` — falha individual não impede demais
- Erros de `publishTaskResume` são propagados e registrados no evento

### Consultas para Diagnóstico

```sql
-- Sessões órfãs atuais (sem claim)
SELECT s.id, s.tarefa_id, t.external_id, s.opened_at, s.analysis_execution_id
  FROM analyst_task_sessions s
  INNER JOIN tarefas t ON t.id = s.tarefa_id
  LEFT JOIN task_runtime_facts f ON f.tarefa_id = s.tarefa_id
 WHERE s.status = 'active'
   AND (f.analysis_started_at IS NULL OR f.analysis_execution_id != s.analysis_execution_id)
   AND s.opened_at < NOW() - INTERVAL 10 MINUTE;

-- Histórico de sessões órfãs limpas
SELECT tarefa_external_id, evento, payload, created_at
  FROM tarefa_eventos
 WHERE evento = 'analysis_session_orphaned'
 ORDER BY created_at DESC
 LIMIT 50;
```

## Limitações e Premissas

### Margem de 10 Minutos

- Evita race condition com análise em andamento que ainda não registrou claim
- Análises muito longas (>10min sem claim) são improváveis (timeout do Console)
- Ajustável via query se necessário (não exposto como config)

### Instância Única

- Guardas em memória (reconciliadores) assumem 1 réplica da API
- Se escalar para múltiplas réplicas, migrar coordenação para locks de banco

### Callback Opcional

- `publishTaskResume` é opcional no config
- Se não injetado, sessão é limpa mas reanálise não é disparada automaticamente
- Útil para ambientes de teste ou quando reanálise deve ser manual

## Referências

- **Incidente original:** Tarefa 873 — sessões 195 e 197 em limbo
- **AnalysisClaimReconciler:** `src/coordinator/AnalysisClaimReconciler.ts`
- **AnalysisSessionRecoveryReconciler:** `src/coordinator/AnalysisSessionRecoveryReconciler.ts`
- **TaskEventSink:** `src/coordinator/TaskEventRecorder.ts`
- **Documentação relacionada:** `INCIDENTE-862-CLAIM-ORFAO-ANALISE.md`
