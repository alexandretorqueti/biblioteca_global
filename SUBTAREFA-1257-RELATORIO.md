# Subtarefa 1257 — Backend: classificar, persistir e notificar conflitos de merge no deploy

## Status: ✅ CONCLUÍDA

## Resumo da Implementação

### 1. Classificação de Conflitos de Merge (DeployConsumer.ts)

**Arquivo modificado:** `projects/gerenteagentes/motor-v3/src/deploy/DeployConsumer.ts`

#### Método `promote()` — Detecção Estruturada de Conflitos

- **Antes:** Lançava erro genérico `Error("Conflito de merge ao promover...")` sem dados estruturados
- **Agora:** Captura dados completos do conflito antes do `merge --abort`:
  - `baseBranch`: branch de destino (ex: `base-desenvolvimento`)
  - `taskBranch`: branch da tarefa (ex: `motor-v3-work/integration-abc123`)
  - `baseCommit`: commit atual da base
  - `taskCommit`: commit da tarefa que falhou
  - `mergeBaseCommit`: commit-base do merge (ancestral comum)
  - `conflictFiles`: lista de arquivos conflitantes
  - `command`: comando git que falhou

- **Erro estruturado:** Cria objeto `Error` com propriedades extras:
  ```typescript
  error.isMergeConflict = true
  error.conflictData = { baseBranch, taskBranch, baseCommit, taskCommit, mergeBaseCommit, conflictFiles, command }
  ```

#### Método `startPreparedBatch()` — Interceptação e Bloqueio

- **Antes:** Propagava qualquer erro do `promote()` para o `completeBatch()` genérico
- **Agora:** Intercepta erros com `isMergeConflict === true` e chama `blockBatchForMergeConflict()`:
  - Bloqueia todas as tarefas do lote com diagnóstico completo
  - Limpa worktree do lote
  - Não propaga o erro (bloqueio já registrado)
  - Outros erros continuam fluindo para `deploy_failed`

### 2. Persistência e Notificação (DeployRepository.ts)

**Arquivo modificado:** `projects/gerenteagentes/motor-v3/src/deploy/DeployRepository.ts`

#### Novo Método `blockBatchForMergeConflict()`

Persiste bloqueio completo em **transação única**:

1. **Atualiza `deploy_batches` e `deploy_requests`** para `status='failed'`

2. **Insere em `bloqueios`** com `block_reason='merge_conflict'`:
   - `block_command`: comando git que falhou
   - `block_excerpt`: resumo legível com arquivos conflitantes

3. **Insere em `promotion_conflict_analyses`** com diagnóstico estruturado:
   - `fingerprint`: identificador único do conflito
   - `base_branch`, `task_branch`: branches envolvidas
   - `base_commit`, `task_commit`, `merge_base_commit`: commits do contexto
   - `conflict_files_json`: JSON com lista de arquivos conflitantes
   - `evidence_json`: JSON com evidência completa (type, branches, commits, arquivos, comando, batchId)
   - `status='pending'`, `confidence='high'`, `recommendation='manual_rebase'`

4. **Insere em `tarefa_chats`** com mensagem descritiva (role='assistant'):
   - Explica o que aconteceu (conflito de merge na promoção)
   - Lista arquivos conflitantes com formatação Markdown
   - Mostra commit da tarefa, branch de destino e comando que falhou
   - Indica ação necessária (rebase/manual merge)

5. **Publica evento `TASK_BLOCKED`** no outbox (feed operacional):
   - `blockReason='merge_conflict'`
   - `conflictFiles`, `baseBranch`, `taskBranch`, `taskCommit` no payload
   - Monitor-Resolvedor é acionado automaticamente

### 3. Extensão do Contrato de Eventos (TaskBlockedEvent.ts)

**Arquivo modificado:** `projects/gerenteagentes/motor-v3/src/monitor/TaskBlockedEvent.ts`

#### Interface `TaskBlockedPayload` — Campos Opcionais para Conflito

Adicionados campos opcionais para diagnóstico de conflito:
```typescript
conflictFiles?: string[]
baseBranch?: string
taskBranch?: string
taskCommit?: string
```

Permite que consumidores do evento `TASK_BLOCKED` acessem dados estruturados sem parsing de texto.

### 4. Testes Abrangentes

**Arquivo criado:** `projects/gerenteagentes/motor-v3/test/deploy-consumer-merge-conflict.test.ts`

#### Cenários Cobertos (6 testes):

1. ✅ **Conflito real de merge** → classificado como `merge_conflict` com dados estruturados
2. ✅ **Lista completa de arquivos conflitantes** → todos os arquivos incluídos no diagnóstico
3. ✅ **Falha genérica de deploy** → NÃO classificada como `merge_conflict` (sem arquivos conflitantes)
4. ✅ **Cherry-pick noop** → detectado como alteração simultânea sem conflito real
5. ✅ **Diferenciação** → conflito real vs. alteração simultânea sem conflito
6. ✅ **Persistência completa** → `bloqueios`, `promotion_conflict_analyses`, `tarefa_chats` e outbox

## Critérios de Aceite — Validação

| Critério | Status | Evidência |
|----------|--------|-----------|
| Conflito real gera bloqueio com `block_reason='merge_conflict'` | ✅ | Teste 1 + código `blockBatchForMergeConflict()` |
| Registro em `promotion_conflict_analyses` com branches, commit, arquivos e comando | ✅ | INSERT com todos os campos estruturados |
| Falha sem conflito continua como `deploy_failed` | ✅ | Teste 3 + fluxo existente em `completeBatch()` |
| Cherry-pick noop não gera bloqueio | ✅ | Teste 4 + método `skipNoopCherryPickConflict()` existente |
| Mensagem descritiva no chat da tarefa | ✅ | INSERT em `tarefa_chats` com Markdown formatado |
| Evento no feed operacional | ✅ | `TASK_BLOCKED` publicado no outbox com payload estendido |
| Testes cobrem os 3 cenários | ✅ | 6 testes passando (conflito real, noop, falha genérica) |

## Resultado dos Testes

```
Test Files  63 passed (63)
Tests       432 passed (432)
```

**Novos testes:** 6 testes em `deploy-consumer-merge-conflict.test.ts`
**Testes existentes:** Todos os 426 testes anteriores continuam passando

## Impacto e Compatibilidade

- **Retrocompatível:** Fluxo existente de `deploy_failed` não foi alterado
- **Sem breaking changes:** Interface `TaskBlockedPayload` apenas adicionou campos opcionais
- **Transacional:** Todas as operações de persistência em transação única (rollback em falha)
- **Auditável:** Dados estruturados em JSON permitem análise posterior e UI rica

## Próximos Passos (Outras Subtarefas)

Esta subtarefa implementou **apenas o backend**. Subtarefas seguintes devem:

1. **Frontend:** Exibir diagnóstico completo no detalhe da tarefa bloqueada
2. **Frontend:** Aproveitar botão "Ver Conflitos" do `TaskCodeViewer` com dados de `promotion_conflict_analyses`
3. **Frontend:** Mostrar mensagem do chat no histórico da tarefa
4. **Backend (opcional):** Integrar com Monitor-Resolvedor para sugestão automática de resolução

## Arquivos Modificados

1. `projects/gerenteagentes/motor-v3/src/deploy/DeployConsumer.ts`
2. `projects/gerenteagentes/motor-v3/src/deploy/DeployRepository.ts`
3. `projects/gerenteagentes/motor-v3/src/monitor/TaskBlockedEvent.ts`
4. `projects/gerenteagentes/motor-v3/test/deploy-consumer-merge-conflict.test.ts` (novo)

## Commit Sugerido

```
feat(motor-v3): classificar e persistir conflitos de merge no deploy com diagnóstico estruturado

- Detecta conflitos reais de merge em promote() com dados estruturados (branches, commits, arquivos)
- Persiste em bloqueios (merge_conflict), promotion_conflict_analyses e tarefa_chats
- Publica evento TASK_BLOCKED com payload estendido no feed operacional
- Diferencia conflito real de alteração simultânea sem conflito (cherry-pick noop)
- Mantém falhas genéricas como deploy_failed
- 6 testes cobrindo conflito real, noop e falha genérica

Refs: tarefa task-p2-926, subtarefa 1257
```
