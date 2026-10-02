# Contrato Realtime — Mapa de Agentes

**Status:** Contrato formalizado e implementado.  
**Data:** 2026-10-02  
**Escopo:** Define os eventos, canais de inscrição, snapshots e estratégia de reconciliação para o Mapa de Agentes.

## 1. Visão Geral

O Mapa de Agentes utiliza WebSocket para receber atualizações em tempo real, eliminando a necessidade de polling periódico. O contrato é dividido em três canais de inscrição:

1. **`task`** — inscrição em uma tarefa específica (detalhe)
2. **`project-feed`** — feed operacional agregado do projeto
3. **`map`** — todas as tarefas do projeto (mapa completo)

## 2. Canais de Inscrição

### 2.1 Canal `task` (detalhe de tarefa)

**Propósito:** Receber eventos de uma tarefa específica e seu detalhe (subtarefas, atividades, chat, histórico, diagnósticos).

**Mensagem do cliente:**
```json
{
  "type": "subscribe",
  "channel": "task",
  "taskId": 42,
  "lastSequence": 5
}
```

**Respostas do servidor:**
- `subscribed` — confirmação com `currentSequence`
- `replay_unavailable` — replay indisponível (cursor fora do buffer)
- `event` — eventos da tarefa
- `task_snapshot` — snapshot inicial do detalhe (opcional)

### 2.2 Canal `project-feed` (feed operacional)

**Propósito:** Receber feed operacional agregado do projeto (mensagens, eventos, ações pendentes).

**Mensagem do cliente:**
```json
{
  "type": "subscribe",
  "channel": "project-feed",
  "lastSequence": 10
}
```

**Respostas do servidor:**
- `feed_subscribed` — confirmação com `currentSequence`
- `feed_replay_unavailable` — replay indisponível
- `event` — eventos do projeto

### 2.3 Canal `map` (mapa completo)

**Propósito:** Receber eventos de todas as tarefas do projeto para atualizar o mapa.

**Mensagem do cliente:**
```json
{
  "type": "subscribe",
  "channel": "map",
  "lastSequence": 3
}
```

**Respostas do servidor:**
- `map_snapshot` — snapshot inicial com todas as tarefas e contadores
- `map_subscribed` — confirmação com `currentSequence`
- `map_replay_unavailable` — replay indisponível
- `event` — eventos de qualquer tarefa do projeto

## 3. Catálogo de Eventos

### 3.1 Eventos de Tarefa

| Evento | Descrição | Payload mínimo |
|---|---|---|
| `task.created` | Tarefa criada | `title`, `status` |
| `task.updated` | Tarefa editada | campos alterados |
| `task.deleted` | Tarefa excluída | — |
| `task.status.changed` | Status alterado | `previousStatus?`, `status` |
| `task.counters.updated` | Contadores atualizados | `counters: { total, pending?, running?, completed?, failed? }` |

### 3.2 Eventos de Subtarefa

| Evento | Descrição | Payload mínimo |
|---|---|---|
| `subtask.created` | Subtarefa criada | `seq`, `title`, `status` |
| `subtask.updated` | Subtarefa editada | campos alterados |
| `subtask.deleted` | Subtarefa excluída | — |
| `subtask.status.changed` | Status alterado | `previousStatus?`, `status` |

### 3.3 Eventos de Atividade do Motor

| Evento | Descrição | Payload mínimo |
|---|---|---|
| `activity.created` | Atividade registrada | `type`, `message` |
| `activity.updated` | Atividade atualizada | campos alterados |
| `started` | Execução iniciada | `executionId`, `phase` |
| `progress` | Progresso da execução | `executionId`, `message` |
| `log` | Log de execução | `executionId`, `message`, `level?` |
| `heartbeat` | Heartbeat da execução | `executionId` |
| `completed` | Execução concluída | `executionId`, `outcome` |
| `failed` | Execução falhou | `executionId`, `message` |
| `model_unavailable` | Modelo indisponível | `model`, `message` |
| `developer_branch_integrated` | Branch integrada | `branch` |
| `deployed` | Deploy realizado | `environment` |
| `clarifying` | Agente solicitando esclarecimento | `message` |
| `system_alert` | Alerta do sistema | `message` |
| `system_recovered` | Sistema recuperado | `message` |

### 3.4 Eventos de Chat e Interação

| Evento | Descrição | Payload mínimo |
|---|---|---|
| `chat.message.created` | Mensagem de chat criada | `id`, `role`, `texto`, `createdAt` |
| `chat.message.updated` | Mensagem de chat atualizada | `id`, campos alterados |
| `task.chat.delivery.updated` | Entrega de mensagem atualizada | `messageId`, `deliveryId`, `state`, `error?` |
| `task.interaction.checkpoint_requested` | Checkpoint solicitado | `phase`, `subtaskId?`, `runId?` |
| `task.interaction.awaiting` | Aguardando interação | `phase`, `subtaskId?`, `sessionKey`, `summary` |
| `task.interaction.resumed` | Interação retomada | `phase`, `subtaskId?`, `sessionKey` |

### 3.5 Eventos de Diagnóstico e Histórico

| Evento | Descrição | Payload mínimo |
|---|---|---|
| `deploy.diagnostics.updated` | Diagnóstico de deploy atualizado | `canStart`, `reasons`, `pendingRequests` |
| `history.entry.created` | Entrada de histórico criada | `event`, `occurredAt`, `payload?` |

### 3.6 Eventos Legados (Compatibilidade)

| Evento | Descrição |
|---|---|
| `task.started` | Tarefa iniciada (legado) |
| `task.error` | Erro na tarefa (legado) |
| `task.timeout` | Timeout na tarefa (legado) |
| `task.command.started` | Comando iniciado (legado) |
| `task.command.output` | Saída de comando (legado) |
| `task.command.finished` | Comando finalizado (legado) |

## 4. Snapshots Iniciais

### 4.1 Snapshot do Mapa (`map_snapshot`)

Enviado imediatamente após inscrição no canal `map`. Contém o estado atual de todas as tarefas do projeto.

```json
{
  "type": "map_snapshot",
  "projectId": 7,
  "currentSequence": 10,
  "snapshot": {
    "projectId": 7,
    "tasks": [
      {
        "taskId": 42,
        "title": "Implementar feature X",
        "status": "running",
        "counters": {
          "total": 5,
          "pending": 1,
          "running": 2,
          "completed": 2,
          "failed": 0
        },
        "updatedAt": "2026-10-02T10:00:00Z"
      }
    ],
    "counters": {
      "total": 10,
      "pending": 3,
      "running": 4,
      "completed": 2,
      "failed": 1
    }
  }
}
```

### 4.2 Snapshot de Detalhe (`task_snapshot`)

Enviado opcionalmente após inscrição no canal `task`. Contém o estado atual do detalhe da tarefa.

```json
{
  "type": "task_snapshot",
  "taskId": 42,
  "currentSequence": 5,
  "snapshot": {
    "projectId": 7,
    "taskId": 42,
    "task": { "id": 42, "title": "Implementar feature X", "status": "running" },
    "subtasks": [
      { "id": 1, "seq": 1, "title": "Subtarefa 1", "status": "completed" }
    ],
    "activities": [
      { "id": 1, "type": "execution", "message": "Executando testes" }
    ],
    "diagnostics": [
      { "canStart": true, "reasons": [] }
    ],
    "history": [
      { "id": 1, "event": "task.started", "occurredAt": "2026-10-02T09:00:00Z" }
    ],
    "chat": [
      { "id": 1, "role": "user", "text": "Olá", "createdAt": "2026-10-02T09:30:00Z" }
    ]
  }
}
```

## 5. Sequência e Replay

### 5.1 Sequência Monotônica

Cada evento recebe um número de sequência único e crescente por projeto. A sequência é mantida pelo `RealtimeService` e incrementada a cada evento publicado.

### 5.2 Replay de Eventos

Ao se inscrever, o cliente pode fornecer `lastSequence` para receber apenas eventos posteriores. O servidor tenta replay a partir do buffer em memória.

**Limitações:**
- Buffer limitado a 500 eventos por tarefa e 5000 eventos por projeto
- Se `lastSequence` estiver fora do buffer, o servidor envia `replay_unavailable` (ou `feed_replay_unavailable` / `map_replay_unavailable`)

### 5.3 Estratégia de Reconciliação

Quando o cliente recebe `replay_unavailable`:

1. **Não confiar no estado local** — o buffer pode ter perdido eventos críticos
2. **Recarregar snapshot completo** — fazer requisição HTTP para obter o estado atual
   - Canal `task`: `GET /gerenteagentes/tarefas/:id/motor-detail`
   - Canal `map`: `GET /gerenteagentes/tarefas-com-status`
   - Canal `project-feed`: `GET /gerenteagentes/operational-feed`
3. **Resetar `lastSequence`** — usar `currentSequence` do snapshot como base
4. **Continuar recebendo eventos** — o WebSocket continua ativo e recebe novos eventos

**Exemplo de reconciliação:**
```typescript
client.onMessage = (message) => {
  if (message.type === "replay_unavailable") {
    // Recarregar estado completo via HTTP
    await reloadTaskDetail(message.taskId)
    // lastSequence já foi atualizado pelo cliente
    return
  }
  if (message.type === "map_replay_unavailable") {
    await reloadMapSnapshot()
    return
  }
  if (message.type === "feed_replay_unavailable") {
    await reloadOperationalFeed()
    return
  }
  // Processar eventos normalmente
  if (message.type === "event") {
    applyEvent(message.event)
  }
}
```

## 6. Deduplicação

### 6.1 Servidor

O `RealtimeService` mantém um `Set<string>` de `eventId` recebidos. Eventos duplicados são ignorados e o envelope original é retornado.

### 6.2 Cliente

O `RealtimeClient` mantém um `Set<string>` de `eventId` recebidos. Eventos duplicados são ignorados antes de entregar ao `onMessage`.

## 7. Invariantes

1. **Todo evento tem `eventId` único e deduplicável** — UUID v4 gerado pelo emissor
2. **Sequência monotônica por escopo** — incrementada pelo servidor por projeto
3. **`projectId` + `taskId` + `subtaskId` identificáveis** — todos os eventos têm contexto completo
4. **Eventos desconhecidos são ignorados com segurança** — schema rejeita tipos não catalogados
5. **Nenhum evento é emitido antes do commit da mutação** — servidor publica apenas após transação confirmada

## 8. Segurança

### 8.1 Autenticação

- WebSocket usa ticket temporário (JWT de 30s com `kind: "ws-ticket"`)
- Ticket obtido via `GET /realtime/ticket` com access token
- Ticket não pode ser usado como Bearer em outras rotas

### 8.2 Autorização

- Cliente só recebe eventos do projeto autenticado (`projetoId` do token)
- TODO: validar permissão da tarefa antes de aceitar inscrição no canal `task`

## 9. Erros

| Código | Descrição |
|---|---|
| `INVALID_SUBSCRIPTION` | Mensagem de inscrição inválida |
| `MAP_SNAPSHOT_UNAVAILABLE` | Provider de snapshot do mapa não configurado |
| `MAP_SNAPSHOT_FAILED` | Falha ao obter snapshot do mapa |

## 10. Exemplos de Uso

### 10.1 Inscrição no Mapa

```typescript
const client = new RealtimeClient({
  url: "wss://api.example.com/api/realtime/ws",
  baseUrl: "https://api.example.com/api",
  channel: "map",
  getAccessToken: () => token,
  onMessage: (message) => {
    if (message.type === "map_snapshot") {
      setTasks(message.snapshot.tasks)
      setCounters(message.snapshot.counters)
    }
    if (message.type === "event") {
      applyEvent(message.event)
    }
    if (message.type === "map_replay_unavailable") {
      reloadMapSnapshot()
    }
  },
})
await client.connect()
```

### 10.2 Inscrição no Detalhe

```typescript
const client = new RealtimeClient({
  url: "wss://api.example.com/api/realtime/ws",
  baseUrl: "https://api.example.com/api",
  channel: "task",
  taskId: 42,
  getAccessToken: () => token,
  onMessage: (message) => {
    if (message.type === "event") {
      applyTaskEvent(message.event)
    }
    if (message.type === "replay_unavailable") {
      reloadTaskDetail(42)
    }
  },
})
await client.connect()
```

## 11. Arquivos do Contrato

- **Schema compartilhado:** `packages/shared/src/realtime.ts`
- **Cliente:** `packages/api-client/src/realtime.ts`
- **Serviço:** `apps/api/src/modules/realtime/realtime.service.ts`
- **Gateway:** `apps/api/src/modules/realtime/realtime.gateway.ts`
- **Testes de schema:** `packages/shared/src/__tests__/realtime.test.ts`
- **Testes do cliente:** `packages/api-client/src/__tests__/realtime-client.spec.ts`
- **Testes do serviço:** `apps/api/src/modules/realtime/realtime.service.spec.ts`

## 12. Fora de Escopo

- Alterações em `compose.yaml`, Gateway ou configuração do OpenClaw
- Implementação de streaming token a token
- Mensagens entre projetos diferentes
- Uso do WebSocket para autorizar ações críticas por texto livre
