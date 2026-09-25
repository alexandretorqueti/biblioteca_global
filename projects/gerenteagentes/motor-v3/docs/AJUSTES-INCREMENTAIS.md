# Ajustes Incrementais via Chat da Tarefa

> **Status:** Implementado (2026-09-25)
> **Tarefa:** task-p2-896 — Ajustes incrementais pós-deploy via chat da tarefa

## Visão Geral

Permite que o usuário solicite ajustes em uma tarefa já **deployed** ou **completed** diretamente pelo chat da tarefa, sem precisar criar uma nova tarefa do zero. O motor cria uma nova **generation** da tarefa, o analista gera subtarefas incrementais, e o motor executa apenas as subtarefas da generation atual.

## Fluxo Completo

```
Usuário → Chat da tarefa (deployed/completed)
    ↓
POST /api/motor/task/:id/adjustment { message }
    ↓
Motor valida status (deployed/completed)
    ↓
Calcula nextGeneration = MAX(subtarefas.generation) + 1
    ↓
Registra mensagem do usuário em tarefa_chats
    ↓
Enfileira TASK_ADJUSTMENT_REQUESTED { message, generation }
    ↓
TaskAdjustmentConsumer consome:
  - Monta prompt com contexto da geração anterior
  - Chama ConsoleAnalystRunner.run()
  - Analista cria subtarefas com generation = nextGeneration
    ↓
Motor executa APENAS subtarefas da generation atual
    ↓
Deploy incremental (commit já é incremental via git merge)
    ↓
Tarefa volta para deployed (generation = N no facts)
```

## Schema (Migration 0069)

### Colunas adicionadas

| Tabela | Coluna | Tipo | Default | Descrição |
|--------|--------|------|---------|-----------|
| `subtarefas` | `generation` | INT NOT NULL | 1 | Generation da subtarefa (1 = original) |
| `deploy_requests` | `generation` | INT NOT NULL | 1 | Generation do deploy |
| `deploy_requests` | `parent_generation` | INT NULL | NULL | Generation anterior (NULL na primeira) |

### Constraint alterada

- `deploy_requests_tarefa_unique` → `deploy_requests_tarefa_generation_unique` (`tarefa_id`, `generation`)

### Governança

- **Comando:** `C20_TASK_ADJUSTMENT_REQUESTED` (message_type: `TASK_ADJUSTMENT_REQUESTED`)
- **Ação:** `A40_ACCEPT_ADJUSTMENT_REQUEST`
- **Política:** `P20_ACCEPT_ADJUSTMENT_REQUEST` — aceita apenas quando tarefa está deployed ou completed
- **Primitivas:** `register_adjustment_request` (db) + `start_adjustment_analyst` (control)

## API

### Endpoint de Ajuste

```http
POST /api/motor/task/:id/adjustment
Content-Type: application/json

{
  "message": "O botão de salvar não está funcionando após o deploy"
}
```

**Resposta (202 Accepted):**
```json
{
  "ok": true,
  "accepted": true,
  "generation": 2,
  "messageId": "msg-abc123"
}
```

**Erros:**
- `400` — message obrigatório ou vazio
- `404` — tarefa não encontrada
- `409` — tarefa não está em status deployed ou completed
- `503` — queue não inicializada

### Proxy NestJS

O endpoint também está disponível via proxy NestJS:

```http
POST /api/gerenteagentes/tarefas/:id/adjustment
```

## Execução por Generation

### Filtro no reserveNextSubtask

O `DevelopmentExecutionRepository.reserveNextSubtask` filtra apenas subtarefas da generation atual:

```sql
WHERE generation = (SELECT MAX(generation) FROM subtarefas WHERE tarefa_id = ?)
  AND status = 'pending'
```

Isso garante que subtarefas de generations anteriores não sejam re-executadas.

### Prompt do DEV

O prompt do DEV inclui contexto da generation:

```
Esta é a generation {N} da tarefa. As generations anteriores já foram deployadas.
Faça apenas mudanças incrementais para o ajuste solicitado.
```

## Deploy Incremental

- `DeployRepository.requestDeploy` grava `generation` e `parent_generation` no `deploy_requests`
- `DeployConsumer` passa `generation` para o script de deploy
- O commit já é incremental (git merge da branch nova sobre base atualizada)
- `promoteTaskBranch` (integration lock) funciona normalmente

## Chat e Contexto do Analista

### Prompt do Analista em Ajuste

O prompt inclui:
- Descrição original da tarefa
- Lista de subtarefas das generations anteriores (título, status, commit)
- Mensagem de ajuste do usuário
- Instrução: "Crie subtarefas incrementais para resolver o ajuste. Não refaça o que já foi feito."

### Mensagens no Chat

- Mensagens do usuário e respostas do analista aparecem no chat da tarefa
- Cada mensagem pode ter um campo `generation` indicando a qual generation pertence
- O frontend exibe badge "Gen N" para mensagens de generation > 1

## Interface (TaskMonitorScreen)

### Botão "Solicitar Ajuste"

- **Visível apenas** quando status = `deployed` ou `completed`
- Abre modal com textarea para mensagem de ajuste
- Ao enviar, chama `POST /gerenteagentes/tarefas/:id/adjustment`
- Exibe feedback visual (sucesso/erro)

### Chat com Generation Badge

- Mensagens exibem badge "Gen N" quando `generation > 1`
- Badge colorido: info.dark para agente, primary.dark para usuário

### Timeline por Generation

- Quando há múltiplas generations, subtarefas são agrupadas por generation
- Cada group tem header colapsável com badge "Generation N"
- Generation 1 = original (chip outlined), Generation N>1 = ajuste (chip filled secondary)
- Collapse/expand via clique no header da generation

## Testes

### Unitários

- `test/task-adjustment-consumer.test.ts` — consumidor de ajuste
- `test/reserve-subtask-generation-filter.test.ts` — filtro de generation no reserveNextSubtask

### Integração (pendente)

- Tarefa deployada → ajuste → nova subtarefa → execução → deploy → status deployed (generation 2)

## Exemplo de Uso

1. Tarefa #100 está `deployed` (generation 1, 3 subtarefas verificadas)
2. Usuário clica "Solicitar Ajuste" e escreve: "O botão de salvar não funciona"
3. Motor cria generation 2, analista cria subtarefa #4 "Corrigir botão de salvar"
4. DEV executa subtarefa #4 com generation=2, faz commit incremental
5. Deploy blue-green com generation=2, parent_generation=1
6. Tarefa volta para `deployed` com generation=2 no facts
7. Chat mostra histórico completo com badge "Gen 2" nas novas mensagens

## Limitações e Futuro

- **Rollback automático por generation:** feature futura (não implementada)
- **Tarefa filha vinculada:** descartada por complexidade (Opção C)
- **Permissão por papel:** usa roles existentes (admin/gerente/operador)
- **Limite de generations:** não há limite máximo definido (cresce conforme necessário)

## Arquivos Relacionados

- `src/adjustment/TaskAdjustmentConsumer.ts` — consumidor do comando
- `src/start.ts` — endpoint HTTP `/api/motor/task/:id/adjustment`
- `migrations/0069_adjustments_generations.sql` — schema
- `screens/TaskMonitorScreen.tsx` — interface frontend
- `api/gerenteagentes.controller.ts` — proxy NestJS
- `api/gerenteagentes.service.ts` — método `solicitarAjusteTarefa`
