# Guia de Uso — Flags de Governança H1-H5

**Data:** 2026-09-30  
**Versão:** 1.0

---

## Visão Geral

As flags de governança permitem migrar decisões hardcoded para o catálogo de forma gradual e revertível. Cada ponto hardcoded tem sua própria flag na tabela `motor_configuracoes`.

---

## Flags Disponíveis

### H1 — Falha de análise na tentativa final
**Flag:** `governed_failure_analysis_terminal`  
**Ponto:** `TaskCoordinator.handleGovernedFailure()`  
**Comportamento:**
- **OFF (default):** Comportamento legado — `blockForAnalysisFailure()` → bloqueio `analysis_failed` → Atenção
- **ON:** GovernedFailureHandler classifica erro e executa ação do catálogo. Se ação terminal e bem-sucedida → substitui bloqueio legado. Se não → fallback legado.

**Quando ativar:** Após criar eventos/padrões/reações no catálogo para falha de análise (ex: E02_MODEL_UNAVAILABLE, E03_INVALID_JSON).

---

### H2 — Fallback de modelo (cadeia)
**Flag:** `governed_failure_analysis_model_fallback`  
**Ponto:** `ConsoleAnalystRunner.handleGovernedFailure()`  
**Comportamento:**
- **OFF (default):** Comportamento legado — `modelFailureRecorder()` (cooldown) → próximo modelo da cadeia
- **ON:** GovernedFailureHandler classifica erro e executa ação do catálogo. Se ação terminal → para o loop. Se não → fallback legado (modelFailureRecorder + próximo modelo).

**Quando ativar:** Após criar eventos/padrões/reações no catálogo para modelo indisponível (ex: E02_MODEL_UNAVAILABLE já existe).

---

### H3 — Resposta inválida do analista (contrato)
**Flag:** `governed_failure_analysis_invalid_reply`  
**Ponto:** `ConsoleAnalystRunner.handleGovernedFailure()`  
**Comportamento:**
- **OFF (default):** Comportamento legado — mensagem corretiva no mesmo modelo → parse de novo → falhou → próximo modelo
- **ON:** GovernedFailureHandler classifica erro (code: `invalid_json`) e executa ação do catálogo. Se ação terminal → para o loop. Se não → fallback legado.

**Quando ativar:** Após criar eventos/padrões/reações no catálogo para resposta inválida (ex: E03_INVALID_JSON já existe).

---

### H4 — Timeout da sessão do analista
**Flag:** `governed_failure_analysis_timeout`  
**Ponto:** `ConsoleAnalystRunner.handleGovernedFailure()`  
**Comportamento:**
- **OFF (default):** Comportamento legado — próximo modelo da cadeia
- **ON:** GovernedFailureHandler classifica erro (code: `model_timeout`) e executa ação do catálogo. Se ação terminal → para o loop. Se não → fallback legado.

**Quando ativar:** Após criar eventos/padrões/reações no catálogo para timeout (ex: E04_MODEL_TIMEOUT).

---

### H5 — Claim órfão de análise
**Status:** ✅ Já implementado (não requer flag)  
**Ponto:** `AnalysisClaimReconciler`  
**Comportamento:** Reconciliador varre órfãos no boot e recupera claims vencidos.  
**Futuro:** Candidato a primitiva `recover_orphan_claim` (não migrado ainda).

---

## Como Ativar uma Flag

### Via SQL (direto no banco)
```sql
INSERT INTO motor_configuracoes (chave, valor, descricao)
VALUES ('governed_failure_analysis_terminal', 'true', 'Roteia falha terminal de análise pelo catálogo')
ON DUPLICATE KEY UPDATE valor = 'true';
```

### Via API (quando CRUD estiver pronto — Fase 4)
```http
PATCH /gerenteagentes/motor-v3/configuracoes/governed_failure_analysis_terminal
Content-Type: application/json

{ "valor": true }
```

### Via Tela (quando evolução da tela estiver pronta — Fase 4)
1. Abrir tela "Motor v3" → "Configurações"
2. Buscar flag `governed_failure_analysis_terminal`
3. Toggle para ON
4. Salvar

---

## Como Desativar uma Flag (Rollback)

### Via SQL
```sql
UPDATE motor_configuracoes
SET valor = 'false'
WHERE chave = 'governed_failure_analysis_terminal';
```

### Via API
```http
PATCH /gerenteagentes/motor-v3/configuracoes/governed_failure_analysis_terminal
Content-Type: application/json

{ "valor": false }
```

---

## Monitoramento

### Auditoria
Cada decisão governada é auditada em `motor_operation_log`:
- `outcome: 'classified'` — erro classificado pelo catálogo
- `outcome: 'executed'` — ação executada com sucesso
- `outcome: 'uncatalogued'` — erro não catalogado (vai para Monitor)
- `outcome: 'fallback'` — flag OFF ou erro no pipeline (comportamento legado)
- `outcome: 'failed'` — erro no handler (fallback legado)

### Observabilidade
```sql
-- Contar decisões por outcome
SELECT payload_json->>'$.outcome' AS outcome, COUNT(*) AS total
FROM motor_operation_log
WHERE payload_json->>'$.point' LIKE 'analysis_%'
GROUP BY outcome;

-- Ver últimas decisões
SELECT *
FROM motor_operation_log
WHERE payload_json->>'$.point' LIKE 'analysis_%'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Testes de Paridade

Antes de ativar uma flag em produção, validar que o comportamento governado é equivalente ao legado:

### 1. Teste com flag OFF
```bash
# Garantir que flag está OFF
UPDATE motor_configuracoes SET valor = 'false' WHERE chave = 'governed_failure_analysis_terminal';

# Executar cenário de falha de análise
# Validar que comportamento é o mesmo de antes (bloqueio → Atenção)
```

### 2. Teste com flag ON
```bash
# Ativar flag
UPDATE motor_configuracoes SET valor = 'true' WHERE chave = 'governed_failure_analysis_terminal';

# Executar mesmo cenário de falha de análise
# Validar que GovernedFailureHandler classifica e executa ação do catálogo
# Validar que ação terminal substitui bloqueio legado
```

### 3. Comparar resultados
- Ambos devem resolver o problema (bloquear para Atenção ou ação terminal equivalente)
- Flag ON deve ter auditoria completa em `motor_operation_log`
- Flag ON deve permitir ajuste de reação via tela (sem mudar código)

---

## Exemplo Prático

### Cenário: Falha de análise na tentativa final

**Comportamento legado (flag OFF):**
1. Tentativa 3 falha
2. `blockForAnalysisFailure()` → bloqueio `analysis_failed`
3. Tarefa vai para Atenção
4. Humano precisa intervir

**Comportamento governado (flag ON):**
1. Tentativa 3 falha
2. GovernedFailureHandler classifica erro (ex: E02_MODEL_UNAVAILABLE)
3. Busca reação para ocorrência 3 (ex: ação A05_BLOCK_FOR_ATTENTION)
4. Executa primitivas da ação (ex: `blockTask`, `recordEvent`)
5. Tarefa vai para Atenção (mesmo resultado, mas com auditoria e flexibilidade)

**Vantagem do comportamento governado:**
- Pode ajustar reação via tela (ex: 3ª tentativa → retry com modelo diferente, 4ª → Atenção)
- Auditoria completa (qual evento, qual ação, quais primitivas)
- Rollback sem deploy (desativar flag)

---

## Erros Comuns

### 1. Flag ON sem catálogo populado
**Sintoma:** GovernedFailureHandler não encontra evento/pattern → fallback legado  
**Solução:** Criar eventos/padrões/reações no catálogo antes de ativar flag

### 2. Ação terminal não encontrada
**Sintoma:** GovernedFailureHandler executa ação não-terminal → fallback legado  
**Solução:** Criar ação terminal (is_terminal=1) para o evento

### 3. Primitiva não registrada
**Sintoma:** ActionExecutor não encontra primitiva → ação falha → fallback legado  
**Solução:** Registrar primitiva em `src/primitives/index.ts`

### 4. condition_json inválido
**Sintoma:** RuleEvaluator não avalia condição → reação não é selecionada  
**Solução:** Validar JSON com estrutura correta (all/any/field/op/value)

---

## Referências

- **Documento de governança:** `docs/GOVERNANCA-DECISOES-MOTOR-V3.md`
- **Implementação H1-H5:** `docs/GOVERNANCA-H1-H5-IMPLEMENTACAO.md`
- **Migration 0069:** `migrations/0069_motor_v3_governance_conditions.sql`
- **Testes:** `test/governed-failure-handler.test.ts`, `test/rule-evaluator.test.ts`
