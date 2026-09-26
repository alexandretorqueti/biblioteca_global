# Sanitize Session — Reset Automático de Análise

> **Status:** Implementado (2026-09-25)
> **Endpoint:** `POST /api/motor/task/:id/sanitize-session`
> **Serviço:** `SanitizeSessionService` em `src/coordinator/SanitizeSessionService.ts`

## Contexto

Quando uma tarefa falha na análise após esgotar os modelos da cadeia (ex.: tarefa 873 — `model not allowed: deepseek/deepseek-v4-flash`), o motor bloqueia a tarefa com status derivado `blocked` via `AnalysisFailureBlocker`. Antes desta implementação, não havia forma de resetar a tarefa para `planned` sem intervenção manual no banco (DELETE em `task_runtime_facts`, `bloqueios`, etc.).

O endpoint `sanitize-session` existia mas retornava `sessionsArchived: 0` com mensagem "implementação pendente".

## Detecção de Bloqueio por Análise

O serviço detecta automaticamente se a tarefa está bloqueada por falha de análise usando duas condições (OR):

### Condição (a): Bloqueio ativo
- `terminal_status` está vazio (tarefa não terminal)
- **E** existe registro em `bloqueios` com `block_reason = 'analysis_failed'` e `resolved_at IS NULL`

### Condição (b): Evento recente sem conclusão
- Existe evento `analysis_failed` em `tarefa_eventos` nos últimos 7 dias
- **E** o evento mais recente é `analysis_failed` (não há `analysis_completed` subsequente)

Se nenhuma condição for atendida, o endpoint retorna `analysisReset: false` e preserva o comportamento original (apenas arquivamento de sessão).

## Reset Transacional

Quando o bloqueio é detectado, o reset é executado em **transação atômica**:

1. **DELETE** `task_runtime_facts WHERE tarefa_id = ?`
   - Limpa `terminal_status`, `analysis_started_at`, `analysis_execution_id`
2. **DELETE** `bloqueios WHERE tarefa_id = ? AND block_reason = 'analysis_failed'`
   - Remove o bloqueio que impede o re-processamento
3. **UPDATE** `tarefas SET paused_at = NULL WHERE id = ?`
   - Despausa a tarefa se estiver pausada
4. **INSERT** evento `analysis_reset` em `tarefa_eventos`
   - Payload: `{ previousStatus: 'blocked', reason: 'sanitize_session' }`

Se qualquer passo falhar, **rollback** reverte tudo. A transação usa `pool.getConnection()` + `beginTransaction()`/`commit()`/`rollback()`.

## Arquivamento de Sessão Console

Antes da transação, o serviço tenta arquivar a sessão no Console OpenClaw via `ConsoleHttpApi.archiveSession()`:

- **Best-effort:** erro de arquivamento **não** derruba o fluxo
- `sessionsArchived: 1` se sucesso, `0` se falha ou Console indisponível
- Implementado como `POST /api/sessions/archive` com `{ key: sessionKey }`

## Resposta

### Com bloqueio de análise detectado
```json
{
  "ok": true,
  "sessionsArchived": 1,
  "analysisReset": true,
  "message": "Sessão arquivada e análise resetada. Tarefa pronta para nova análise."
}
```

### Sem bloqueio de análise
```json
{
  "ok": true,
  "sessionsArchived": 0,
  "analysisReset": false,
  "message": "Sessão arquivada. Nenhum bloqueio de análise detectado."
}
```

### Tarefa não encontrada
```json
{
  "ok": false,
  "sessionsArchived": 0,
  "analysisReset": false,
  "message": "Task not found",
  "error": "not_found"
}
```

## Fluxo de Retomada

Após o reset, a tarefa volta ao estado `planned` (sem `terminal_status`, sem bloqueios):

1. O `AnalysisClaimReconciler` ou o pump normal do `TaskCoordinator` detecta a tarefa `planned`
2. O analista é acionado novamente com a cadeia de modelos
3. Nova sessão do Console é criada (a anterior foi arquivada)

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `src/coordinator/SanitizeSessionService.ts` | Serviço testável com detecção + reset |
| `src/coordinator/index.ts` | Export do serviço |
| `src/analysis/ConsoleHttpApi.ts` | Método `archiveSession` adicionado |
| `src/start.ts` | Handler delega ao `SanitizeSessionService` |
| `test/sanitize-session.test.ts` | Testes unitários (fakePool) |

## Testes

```bash
cd motor-v3 && npx vitest run test/sanitize-session.test.ts
```

Cobertura:
- Detecção: bloqueio ativo + terminal vazio → reset
- Detecção: evento `analysis_failed` recente → reset
- Não-detecção: último evento é `analysis_completed` → sem reset
- Não-detecção: `terminal_status` preenchido → sem reset
- Transação: DELETE/UPDATE/INSERT na ordem correta
- Rollback: falha na transação → rollback executado
- Console archiver: sucesso → `sessionsArchived: 1`
- Console archiver: erro → não derruba o fluxo
- Tarefa inexistente → `ok: false, error: not_found`
