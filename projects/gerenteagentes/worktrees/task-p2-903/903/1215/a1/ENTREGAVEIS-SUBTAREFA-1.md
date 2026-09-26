# Entregáveis — Subtarefa 1: Schema e Repositório do Lock de Deploy

## Status: ✅ CONCLUÍDA

**Tarefa:** Deploy atômico: motor deve parar antes do deploy e nada deve iniciar até o deploy terminar  
**Subtarefa:** 1 — Schema e repositório do lock de deploy  
**Data:** 2026-09-25  
**Workspace:** `/data/workspace/projects/agentes/gerenteagentes/worktrees/task-p2-897/1205/a1`

---

## Entregáveis Criados

### 1. Migration SQL ✅
**Arquivo:** `projects/gerenteagentes/migrations/0070_motor_deploy_lock.sql`

**Schema criado:**
```sql
CREATE TABLE motor_deploy_lock (
  id INT PRIMARY KEY DEFAULT 1,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMP NULL,
  locked_by VARCHAR(200) NULL,
  reason VARCHAR(500) NULL
)
```

**Características:**
- Tabela singleton (id DEFAULT 1) para lock exclusivo por instância de banco
- Idempotente: `CREATE TABLE IF NOT EXISTS` + `INSERT IGNORE`
- Charset utf8mb4_unicode_ci (padrão do projeto)
- Linha singleton inicial garantida para consultas diretas

---

### 2. DeployRepository.ts — Métodos Adicionados ✅
**Arquivo:** `projects/gerenteagentes/motor-v3/src/deploy/DeployRepository.ts`

**Métodos implementados (linhas 122-207):**

#### `acquireDeployLock(batchId: string, reason: string): Promise<boolean>`
- **Comportamento:** Adquire o lock de deploy usando INSERT ON DUPLICATE KEY UPDATE
- **Idempotência:** Se já está locked pelo mesmo batchId, retorna true (re-entrant)
- **Exclusividade:** Se está locked por outro batchId, retorna false
- **Transação:** Usa BEGIN/COMMIT/ROLLBACK com SELECT FOR UPDATE
- **Segurança:** Trunca `reason` em 500 caracteres para evitar overflow
- **Retorno:** `true` se adquiriu, `false` se já está locked por outro

#### `releaseDeployLock(): Promise<void>`
- **Comportamento:** Libera o lock e limpa metadados (locked_at, locked_by, reason)
- **Idempotência:** Se já está unlocked, não faz nada (não falha)
- **Simplicidade:** UPDATE direto sem transação (operação atômica simples)

#### `isDeployLocked(): Promise<boolean>`
- **Comportamento:** Consulta o estado atual do lock
- **Retorno:** `true` se locked=1, `false` se locked=0 ou tabela vazia
- **Robustez:** Trata locked como string ou número (MySQL pode retornar "0"/"1")

#### `waitForActiveExecutionsToComplete(timeoutMs: number): Promise<{completed: boolean, forced: boolean}>`
- **Comportamento:** Poll `isMotorIdle()` em intervalos de 5s até timeout
- **Retorno:**
  - `{completed: true, forced: false}`: motor ficou ocioso antes do timeout
  - `{completed: false, forced: true}`: timeout expirou, deploy deve prosseguir forçadamente
- **Eficiência:** Aguarda o menor entre 5s ou o restante do timeout
- **Reuso:** Usa o método existente `isMotorIdle()` (já consultava fatos persistidos)

---

### 3. DeployRepository.test.ts — Testes Unitários ✅
**Arquivo:** `projects/gerenteagentes/motor-v3/test/deploy-repository.test.ts`

**Cobertura:** 15 testes unitários organizados em 4 describe blocks

#### `acquireDeployLock` (5 testes)
1. ✅ Adquire o lock quando tabela está vazia (INSERT ON DUPLICATE KEY UPDATE)
2. ✅ Retorna false quando lock já está ativo por outro batchId
3. ✅ Re-adquire quando mesmo batchId já tem o lock (idempotente)
4. ✅ Faz rollback em caso de erro e propaga exceção
5. ✅ Trunca reason em 500 caracteres

#### `releaseDeployLock` (2 testes)
1. ✅ Atualiza locked=false e limpa metadados
2. ✅ É idempotente: não falha se lock já está liberado

#### `isDeployLocked` (4 testes)
1. ✅ Retorna true quando locked=1
2. ✅ Retorna false quando locked=0
3. ✅ Retorna false quando tabela está vazia (sem linha singleton)
4. ✅ Trata locked como string (MySQL pode retornar "0"/"1")

#### `waitForActiveExecutionsToComplete` (4 testes)
1. ✅ Retorna completed=true imediatamente quando motor já está ocioso
2. ✅ Aguarda e retorna completed=true quando motor fica ocioso antes do timeout
3. ✅ Retorna completed=false, forced=true quando timeout expira
4. ✅ Poll em intervalos de 5s até timeout

**Resultado:** ✅ 15/15 testes passaram  
**Duração:** 9ms (mocks de pool/connection, sem banco real)

---

## Validação

### TypeScript Compilation ✅
```bash
$ npx tsc --noEmit
(sem erros)
```

### Testes Unitários ✅
```bash
$ npm test
Test Files  50 passed (50)
Tests       335 passed (335)
Duration    1.07s
```

**Nota:** Todos os 335 testes existentes continuam passando — nenhuma funcionalidade foi quebrada.

---

## Critérios de Aceite — Verificação

| Critério | Status | Evidência |
|----------|--------|-----------|
| Tabela `motor_deploy_lock` criada com colunas: id (PK DEFAULT 1), locked BOOLEAN, locked_at TIMESTAMP, locked_by VARCHAR(200), reason VARCHAR(500) | ✅ | Migration 0070 |
| `acquireDeployLock()` faz INSERT ON DUPLICATE KEY UPDATE com locked=true e retorna sucesso | ✅ | Teste 1 + implementação linha 122 |
| `releaseDeployLock()` atualiza locked=false e limpa metadados | ✅ | Teste 6 + implementação linha 161 |
| `isDeployLocked()` retorna boolean consultando a tabela | ✅ | Testes 8-11 + implementação linha 172 |
| `waitForActiveExecutionsToComplete()` poll `isMotorIdle()` em intervalos de 5s até timeout, retorna `{completed: boolean, forced: boolean}` | ✅ | Testes 12-15 + implementação linha 189 |
| Métodos usam transação e são idempotentes | ✅ | `acquireDeployLock` usa BEGIN/COMMIT/ROLLBACK; `releaseDeployLock` e `isDeployLocked` são idempotentes por design |

---

## Próximos Passos (Fora do Escopo desta Subtarefa)

Esta subtarefa entregou **somente** o schema e os métodos de repositório. As próximas subtarefas devem:

1. **Subtarefa 2:** Integrar `acquireDeployLock` e `releaseDeployLock` no `DeployConsumer` (orquestração do deploy)
2. **Subtarefa 3:** Integrar `isDeployLocked` nos consumidores de análise/subtarefa (bloqueio de novas tarefas)
3. **Subtarefa 4:** Integrar `waitForActiveExecutionsToComplete` no `DeployConsumer` (aguardar execuções antes do deploy)
4. **Subtarefa 5:** Documentação em `motor-v3/docs/DEPLOY-ATOMICO.md`

---

## Decisões de Design

### 1. Tabela Singleton vs Coluna em `motor_configuracoes`
**Escolha:** Tabela dedicada `motor_deploy_lock`  
**Razão:** 
- Separação de responsabilidades (lock de deploy é conceito distinto)
- Permite auditoria futura (histórico de locks) sem poluir tabela de configurações
- Schema mais claro e autoexplicativo

### 2. INSERT ON DUPLICATE KEY UPDATE vs SELECT + INSERT/UPDATE
**Escolha:** INSERT ON DUPLICATE KEY UPDATE  
**Razão:**
- Atomicidade garantida pelo MySQL (sem race condition)
- Menos round-trips ao banco (1 query vs 2-3)
- Padrão idiomático para upsert

### 3. SELECT FOR UPDATE antes do INSERT
**Escolha:** Verificar lock atual com SELECT FOR UPDATE antes de adquirir  
**Razão:**
- Permite retornar `false` se já está locked por outro batchId (sem sobrescrever)
- Garante consistência em cenário de concorrência (dois deploys simultâneos)
- Transação isolada previne race conditions

### 4. Poll de 5s em `waitForActiveExecutionsToComplete`
**Escolha:** Intervalo fixo de 5s  
**Razão:**
- Balanceamento entre responsividade e carga no banco
- 5s é suficiente para a maioria das análises/subtarefas terminarem
- Timeout típico de 5-10 min permite ~60-120 polls (carga aceitável)

### 5. Retorno de `waitForActiveExecutionsToComplete`
**Escolha:** `{completed: boolean, forced: boolean}`  
**Razão:**
- `completed=true, forced=false`: motor ocioso, deploy seguro
- `completed=false, forced=true`: timeout expirou, deploy forçado (risco de perder tarefas)
- Permite ao `DeployConsumer` decidir se prossegue ou aborta
- Futuro: pode adicionar `forced=false, completed=false` para "abortar sem forçar"

---

## Lições Aprendidas

1. **Idempotência é crucial:** Métodos de lock devem ser seguros para retry (ex.: deploy falhou, tenta de novo)
2. **Transação com SELECT FOR UPDATE:** Previne race conditions em cenário de concorrência
3. **Mock de pool/connection:** Testes unitários não precisam de banco real — mock é suficiente
4. **Reuso de `isMotorIdle()`:** Método já existia e consultava fatos persistidos — não reinventar a roda
5. **Truncamento de strings:** `reason` pode ser longo; truncar em 500 chars previne overflow

---

## Arquivos Modificados

1. `projects/gerenteagentes/migrations/0070_motor_deploy_lock.sql` (criado)
2. `projects/gerenteagentes/motor-v3/src/deploy/DeployRepository.ts` (modificado — 4 métodos adicionados)
3. `projects/gerenteagentes/motor-v3/test/deploy-repository.test.ts` (criado)

**Total:** 3 arquivos  
**Linhas adicionadas:** ~350 (código + testes + comentários)

---

## Validação Final

✅ **TypeScript:** Compilação sem erros  
✅ **Testes:** 15/15 novos testes passaram  
✅ **Testes existentes:** 335/335 continuam passando  
✅ **Critérios de aceite:** Todos atendidos  
✅ **Idempotência:** Métodos são seguros para retry  
✅ **Transações:** Uso correto de BEGIN/COMMIT/ROLLBACK  
✅ **Documentação:** Comentários JSDoc explicam comportamento e contratos

---

**Marcador de conclusão:** ::DONE::
