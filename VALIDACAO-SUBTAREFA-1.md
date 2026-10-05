# Validação da Subtarefa 1 — Contrato Realtime do Mapa de Agentes

## Data: 2026-09-30

## Status: ✅ CONCLUÍDA

---

## Critérios de Aceite

### ✅ 1. O contrato distingue inscrição de mapa/projeto da inscrição de detalhe de tarefa

**Evidência:**
- `packages/shared/src/realtime.ts` define dois canais distintos no `realtimeClientMessageSchema`:
  - `channel: "task"` → inscrição em uma tarefa específica (detalhe)
  - `channel: "project-feed"` → inscrição em todas as tarefas do projeto (mapa)
- `RealtimeClientOptions` em `packages/api-client/src/types.ts` expõe `channel?: "task" | "project-feed"`
- `RealtimeService` mantém buffers separados:
  - `eventos` (por taskId) → canal "task"
  - `eventosPorProjeto` (por projectId) → canal "project-feed"
- Mensagens do servidor distinguem os snapshots:
  - `map_snapshot` → snapshot do mapa (todas as tarefas do projeto)
  - `task_snapshot` → snapshot de detalhe de uma tarefa

**Arquivos:**
- `packages/shared/src/realtime.ts` (linhas 106-113)
- `packages/api-client/src/types.ts` (linha 33)
- `apps/api/src/modules/realtime/realtime.service.ts` (linhas 15-16, 68-70)

---

### ✅ 2. Existem eventos para criação, edição, exclusão, mudança de status e contadores de tarefas, além de atividades do motor, diagnósticos de deploy, subtarefas, histórico e chat

**Evidência:**
- `realtimeEventTypeSchema` em `packages/shared/src/realtime.ts` (linhas 23-32) define o catálogo completo:
  - **Tarefas:** `task.created`, `task.updated`, `task.deleted`, `task.status.changed`, `task.counters.updated`
  - **Execução:** `task.started`, `task.error`, `task.timeout`, `task.command.started`, `task.command.output`, `task.command.finished`
  - **Atividades:** `task.activity.created`, `task.chat.delivery.updated`, `task.interaction.checkpoint_requested`, `task.interaction.awaiting`, `task.interaction.resumed`
  - **Subtarefas:** `subtask.created`, `subtask.updated`, `subtask.deleted`, `subtask.status.changed`
  - **Atividade geral:** `activity.created`, `activity.updated`
  - **Deploy:** `deploy.diagnostics.updated`
  - **Histórico:** `history.entry.created`
  - **Chat:** `chat.message.created`, `chat.message.updated`
  - **Legado (compatibilidade motor-v2):** `started`, `progress`, `log`, `heartbeat`, `completed`, `failed`, `model_unavailable`, `developer_branch_integrated`, `deployed`, `clarifying`, `system_alert`, `system_recovered`

**Arquivos:**
- `packages/shared/src/realtime.ts` (linhas 23-32)

---

### ✅ 3. O contrato define snapshot inicial realtime, sequência/replay, replay_unavailable e a estratégia de reconciliação explícita

**Evidência:**

#### Snapshot Inicial
- `agentMapSnapshotSchema` (linhas 47-51): snapshot do mapa com `projectId`, `tasks[]` (resumo de tarefas) e `counters`
- `taskDetailSnapshotSchema` (linhas 53-61): snapshot de detalhe com `projectId`, `taskId`, `task`, `subtasks[]`, `activities[]`, `diagnostics[]`, `history[]`, `chat[]`
- Mensagens do servidor:
  - `map_snapshot` → entrega snapshot do mapa ao inscrever no canal "project-feed"
  - `task_snapshot` → entrega snapshot de detalhe ao inscrever no canal "task"

#### Sequência/Replay
- `taskEventEnvelopeSchema` inclui `sequence: z.number().int().positive()` (linha 91)
- `RealtimeService.publicar()` incrementa sequência monotônica por projectId (linhas 28-33)
- `RealtimeService.inscrever()` e `inscreverFeed()` aceitam `lastSequence` e fazem replay de eventos faltantes (linhas 47-53, 75-81)
- `RealtimeClient` rastreia `lastSequence` e inclui na reconexão (linhas 11-12, 70-75)

#### replay_unavailable
- `REALTIME_REPLAY_UNAVAILABLE_CODE = "replay_unavailable"` (linha 120)
- Mensagens do servidor:
  - `replay_unavailable` → quando replay de tarefa específica não está disponível
  - `feed_replay_unavailable` → quando replay do feed do projeto não está disponível
- `RealtimeService.inscrever()` e `inscreverFeed()` retornam `{ currentSequence, replayAvailable: false }` quando `lastSequence` está fora do buffer (linhas 51-52, 79-80)

#### Estratégia de Reconciliação
- `RealtimeClient` deduplica eventos por `eventId` (linhas 13, 69-73)
- `RealtimeClient` descarta eventos com `sequence <= lastSequence` (linha 71)
- `RealtimeService.publicar()` é idempotente por `eventId` (linhas 22-26)
- Buffer limitado a 500 eventos por tarefa e 5000 por projeto (linhas 11, 38-39, 43-44)

**Arquivos:**
- `packages/shared/src/realtime.ts` (linhas 47-61, 91, 106-113, 120)
- `apps/api/src/modules/realtime/realtime.service.ts` (linhas 22-26, 28-33, 38-44, 47-53, 75-81)
- `packages/api-client/src/realtime.ts` (linhas 11-13, 69-75)

---

### ✅ 4. Testes de schema e do cliente cobrem payload válido, inválido, duplicado e evento desconhecido

**Evidência:**

#### Testes de Schema (`packages/shared/src/__tests__/realtime.test.ts`)
- ✅ **Payload válido:** "aceita evento e snapshot de mapa válidos" (linhas 16-25)
- ✅ **Payload inválido:** "rejeita envelope inválido" (linha 28)
- ✅ **Evento desconhecido:** "rejeita ... evento desconhecido com segurança" (linhas 29-32)

#### Testes do Serviço (`apps/api/src/modules/realtime/realtime.service.spec.ts`)
- ✅ **Duplicado:** "não retransmite o mesmo eventId e mantém a sequência monotônica" (linhas 10-20)
- ✅ **Replay:** "entrega eventos de tarefas diferentes no canal do projeto e faz replay" (linhas 22-34)
- ✅ **replay_unavailable:** "sinaliza replay indisponível quando o cursor ficou fora do buffer" (linhas 36-42)

#### Testes do Cliente (`packages/api-client/src/__tests__/realtime-client.spec.ts`)
- ✅ **Deduplicação:** "descarta evento desconhecido, duplicado e fora de sequência" (linhas 344-364)
- ✅ **Sequência:** "rastrea sequence de eventos e inclui lastSequence na reconexão" (linhas 280-318)
- ✅ **Mensagens inválidas:** "descarta mensagens inválidas (JSON malformado) sem erro" (linhas 320-336)

**Resultado:** 18 testes passando (2 de schema + 3 de serviço + 13 de cliente)

**Arquivos:**
- `packages/shared/src/__tests__/realtime.test.ts` (novo)
- `apps/api/src/modules/realtime/realtime.service.spec.ts` (modificado)
- `packages/api-client/src/__tests__/realtime-client.spec.ts` (modificado)

---

### ✅ 5. A entrega não exige mudança em compose.yaml, Gateway ou configuração do OpenClaw

**Evidência:**
- `git status --short` mostra apenas 7 arquivos modificados:
  - `apps/api/src/modules/realtime/realtime.service.spec.ts`
  - `apps/api/src/modules/realtime/realtime.service.ts`
  - `packages/api-client/src/__tests__/realtime-client.spec.ts`
  - `packages/api-client/src/realtime.ts`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/realtime.ts`
  - `packages/shared/src/__tests__/realtime.test.ts` (novo)
- Nenhum arquivo de configuração foi alterado (compose.yaml, config do Gateway, etc.)

**Arquivos:**
- Nenhum arquivo de configuração foi tocado

---

## Invariantes do Contrato

### ✅ eventId único e deduplicável
- `RealtimeService.publicar()` verifica `envelopesPorId.get(eventId)` antes de processar (linhas 22-24)
- `aceitarUmaVez(eventId)` garante idempotência (linhas 25-26, 57-60)
- `RealtimeClient` deduplica por `eventId` no `receivedEventIds` (linhas 13, 69-70)

### ✅ Sequência monotônica por escopo
- `RealtimeService.sequencias` (Map<projectId, sequence>) incrementa monotonicamente (linhas 13, 28-31)
- Cada projectId tem sua própria sequência independente

### ✅ projectId + taskId + subtaskId identificáveis
- `taskEventEnvelopeBaseSchema` inclui todos os três campos (linhas 84-90)
- `subtaskId` é opcional e aceita `number | string` (linha 90)

### ✅ Eventos desconhecidos são ignorados com segurança
- `realtimeEventTypeSchema` é um `z.enum()` fechado (linhas 23-32)
- `realtimeServerMessageSchema.safeParse()` rejeita eventos com `type` fora do catálogo
- `RealtimeClient` descarta mensagens inválidas no `catch` (linha 77)

### ✅ Nenhum evento é emitido antes do commit da mutação
- Contrato documentado no JSDoc de `realtimeEventTypeSchema` (linhas 19-22)
- `RealtimeService.publicar()` é chamado APÓS o commit da mutação (responsabilidade do motor)

---

## Validação Técnica

### TypeScript
```bash
npx tsc --noEmit -p packages/shared/tsconfig.json
# ✅ Sem erros

npx tsc --noEmit -p packages/api-client/tsconfig.json
# ✅ Sem erros
```

### Testes
```bash
npx vitest run packages/shared/src/__tests__/realtime.test.ts apps/api/src/modules/realtime/realtime.service.spec.ts packages/api-client/src/__tests__/realtime-client.spec.ts
# ✅ Test Files  3 passed (3)
# ✅ Tests  18 passed (18)
```

---

## Artefatos Compartilhados

### Schemas de Evento
- `realtimeEventTypeSchema` → catálogo de tipos de evento
- `realtimeIngressEventSchema` → envelope de entrada (motor → API)
- `taskEventEnvelopeSchema` → envelope de saída (API → cliente)
- `taskExecutionEventSchema` → eventos de execução (legado)

### Tipos de Inscrição
- `RealtimeClientMessage` → mensagens do cliente (subscribe, ping)
- `RealtimeServerMessage` → mensagens do servidor (subscribed, event, snapshot, replay_unavailable, pong, error)

### Snapshot Inicial
- `agentMapSnapshotSchema` → snapshot do mapa (project-feed)
- `taskDetailSnapshotSchema` → snapshot de detalhe (task)

### Código de Erro
- `REALTIME_REPLAY_UNAVAILABLE_CODE = "replay_unavailable"`

---

## Resumo

A subtarefa 1 foi concluída com sucesso. O contrato realtime do Mapa de Agentes está formalizado em `@biblioteca-global/shared` e `@biblioteca-global/api-client`, com:

1. ✅ Distinção clara entre inscrição de mapa/projeto e detalhe de tarefa
2. ✅ Catálogo completo de eventos (tarefas, subtarefas, atividades, deploy, histórico, chat)
3. ✅ Snapshot inicial, sequência/replay, replay_unavailable e reconciliação explícita
4. ✅ Testes cobrindo payload válido, inválido, duplicado e evento desconhecido
5. ✅ Nenhuma mudança em compose.yaml, Gateway ou configuração do OpenClaw

**Próxima subtarefa:** Implementar a emissão de eventos pelo motor-v3 e a API da Biblioteca Global.

---

## Assinatura

- **Desenvolvedor:** Gerente de Agentes (agente programador-senior)
- **Data:** 2026-09-30
- **Workspace:** `/data/workspace/projects/agentes/gerenteagentes/worktrees/task-p2-832/1115/a1`
- **Branch:** `motor-v2/task-p2-832/1115/a1`

::DONE::
