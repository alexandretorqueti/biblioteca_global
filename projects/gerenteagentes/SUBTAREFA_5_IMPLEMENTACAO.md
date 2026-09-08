# Subtarefa 5: Exibir proposta de plano sem iniciar execução

## Status: ✅ DONE

## Objetivo
Criar o fluxo pelo qual o analista, ao considerar a informação suficiente, registra e apresenta uma proposta de plano para revisão no chat, mantendo a tarefa fora da execução.

## Critérios de Aceite

### ✅ 1. O analista pode marcar que há informação suficiente e produzir proposta
**Implementado em:** `TaskWorker.ts` (já existia)
- O analista retorna um JSON com `subtarefas` quando considera que há informação suficiente
- O `TaskWorker.phaseAnalyze()` detecta isso e persiste como proposta

### ✅ 2. A proposta é persistida com versão identificável
**Implementado em:** `PlanProposalStore.ts` (já existia)
- Função `persistPlanProposal()` cria uma nova versão incremental
- Cada proposta recebe um `version` único por tarefa
- Versões anteriores são mantidas para auditoria

### ✅ 3. A proposta aparece no chat em formato compreensível
**Implementado em:** `ClarificationStore.ts` (NOVO)
- Função `formatPlanProposalMessage()` formata a proposta de forma legível
- Apresenta subtarefas com título, escopo, entregáveis, critérios e dependências
- Inclui ações disponíveis (Aprovar, Solicitar ajustes, Continuar conversando)
- Função `persistTaskPlanProposal()` grava a proposta no chat da tarefa

### ✅ 4. A criação ou exibição da proposta não cria subtarefas, jobs ou itens de fila
**Implementado em:** `TaskWorker.ts` (já existia)
- `persistPlanProposal()` apenas grava na tabela `motor_plan_proposals`
- Não chama `persistPlan()` (que cria subtarefas)
- Não enfileira tarefas nem cria jobs

### ✅ 5. A tarefa passa ao estado aguardando aprovação
**Implementado em:** `TaskCoordinator.ts` (já existia)
- `onTaskPlanProposal()` transita a tarefa para `awaiting_approval`
- Salva transição `propose_plan` no histórico
- Worker encerra sem materializar subtarefas

## Mudanças Implementadas

### 1. ClarificationStore.ts
**Arquivo:** `motor-v2/src/planning/ClarificationStore.ts`

**Adicionado:**
- `formatPlanProposalMessage()`: Formata a proposta de plano para exibição no chat
  - Apresenta versão da proposta
  - Lista subtarefas com detalhes (título, escopo, entregáveis, critérios, dependências)
  - Inclui instruções claras sobre ações disponíveis
  
- `persistTaskPlanProposal()`: Persiste a proposta no chat da tarefa
  - Resolve o ID da tarefa
  - Formata a mensagem usando `formatPlanProposalMessage()`
  - Grava como mensagem do analista (`role: "analyst"`) na tabela `tarefa_chats`

### 2. TaskWorker.ts
**Arquivo:** `motor-v2/src/workers/TaskWorker.ts`

**Modificado:**
- Import adicionado: `persistTaskPlanProposal`
- Após persistir a proposta com `persistPlanProposal()`, chama `persistTaskPlanProposal()` para exibir no chat
- Isso garante que o dono veja a proposta diretamente no chat da tarefa

### 3. ClarificationStore.test.ts
**Arquivo:** `motor-v2/test/ClarificationStore.test.ts`

**Adicionado:**
- Testes para `formatPlanProposalMessage()`:
  - Formatação completa com múltiplas subtarefas
  - Omite campos vazios
  
- Testes para `persistTaskPlanProposal()`:
  - Persistência correta no chat da tarefa
  - Resolução do ID da tarefa
  - Formato da mensagem gravada

## Fluxo Completo

1. **Análise em andamento:** Tarefa está em status `analyzing`
2. **Analista considera informação suficiente:** Retorna JSON com `subtarefas`
3. **TaskWorker persiste proposta:**
   - Chama `persistPlanProposal()` → grava em `motor_plan_proposals` com versão
   - Chama `persistTaskPlanProposal()` → grava no chat da tarefa formatado
4. **TaskCoordinator transita status:**
   - `onTaskPlanProposal()` muda status para `awaiting_approval`
   - Salva transição `propose_plan`
5. **Dono vê proposta no chat:**
   - Mensagem formatada com subtarefas e ações disponíveis
   - Pode aprovar, solicitar ajustes ou continuar conversando
6. **Decisão do dono:**
   - **Aprovar:** `POST /api/motor/task/:id/approve` → materializa subtarefas → status `ready`
   - **Ajustes:** `POST /api/motor/task/:id/request-adjustments` → volta para `analyzing`
   - **Conversar:** `POST /api/motor/task/:id/clarification` → continua na mesma sessão

## Compatibilidade com Fluxo Existente

- ✅ Mantém sessão do analista durante toda a clarificação
- ✅ Encaminha mensagens para a mesma sessão preservando contexto
- ✅ Permite mensagens normais do analista (texto livre)
- ✅ JSON técnico apenas internamente para materializar o plano
- ✅ Histórico completo persistido (sessões, mensagens, transições)
- ✅ Compatível com tarefas antigas em `awaiting_clarification`

## Endpoints Envolvidos

- `GET /api/motor/task/:id/plan-proposal` — Consulta proposta pendente
- `POST /api/motor/task/:id/approve` — Aprova e materializa subtarefas
- `POST /api/motor/task/:id/request-adjustments` — Solicita ajustes
- `POST /api/motor/task/:id/clarification` — Continua conversa

## Tabelas Envolvidas

- `motor_plan_proposals` — Propostas de plano (versões, status, JSON)
- `tarefa_chats` — Mensagens do chat (analyst/user)
- `motor_task_analyst_sessions` — Sessões do analista (contexto persistente)
- `tarefas` — Status da tarefa e transições

## Validação

- ✅ Ambiente validado (pwd, git toplevel, branch)
- ✅ Código modificado sem erros de sintaxe
- ✅ Testes adicionados para novas funções
- ✅ Fluxo completo implementado e documentado
- ✅ Compatibilidade mantida com fluxo existente

## Próximos Passos (Fora do Escopo desta Subtarefa)

- Implementar UI na tela de acompanhamento para exibir a proposta formatada
- Adicionar botões de ação (Aprovar, Ajustar, Conversar) na interface
- Implementar notificação ao dono quando proposta estiver disponível
- Adicionar histórico de versões da proposta na UI
