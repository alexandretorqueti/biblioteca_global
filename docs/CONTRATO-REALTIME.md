# Contrato realtime da Biblioteca Global

Este documento descreve o contrato consumido pelo projeto `gerenteagentes`.
Os schemas e tipos canônicos ficam em `packages/shared/src/realtime.ts`; o
`@biblioteca-global/api-client` os reexporta junto com `RealtimeClient`.

## Fluxo de conexão

1. Com um access token válido do projeto, solicitar `GET /api/realtime/ticket`.
2. Abrir `WS /api/realtime/ws?ticket=<ticket>&taskId=<id>`.
3. Quando o socket abrir, enviar uma `RealtimeClientMessage`:

```json
{"type":"subscribe","channel":"task","taskId":42,"lastSequence":17}
```

O ticket é temporário e serve apenas para o handshake WebSocket. O projeto da
sessão é obtido das claims do token; `taskId` não altera esse escopo.

## Mensagens

Mensagens de cliente:

- `subscribe`: inscreve o socket em uma tarefa e solicita eventos posteriores
  a `lastSequence` quando informado.
- `ping`: solicita `pong`.

Mensagens do servidor:

- `subscribed`: confirma a inscrição e informa `currentSequence`.
- `event`: entrega um `TaskEventEnvelope`.
- `replay_unavailable`: informa que o início solicitado já saiu do buffer;
  o consumidor deve recarregar os dados por REST.
- `pong`: resposta de `ping`.
- `error`: erro de protocolo ou inscrição, com `code` e `message`.

## Envelope e ingestão

O motor publica em `POST /api/internal/realtime/events` com Bearer token
exclusivo de ingestão. O corpo é um `RealtimeIngressEvent`:

```json
{
  "eventId":"evt-1",
  "occurredAt":"2026-09-14T12:00:00.000Z",
  "source":"gerenteagentes-motor-v2",
  "projectId":7,
  "taskId":42,
  "sourceTaskId":"task-42",
  "sourceProjectSlug":"gerenteagentes",
  "subtaskId":9,
  "type":"task.status.changed",
  "payload":{"status":"running"}
}
```

A API valida o envelope, deduplica por `eventId`, atribui `sequence` e envia o
`TaskEventEnvelope` aos clientes inscritos. Se o header `Idempotency-Key` for
enviado, ele deve ser igual a `eventId`.

## Tipos de evento

`taskExecutionEventSchema` define os eventos de execução padronizados:
`task.started`, `task.status.changed`, `task.command.started`,
`task.command.output`, `task.command.finished`, `task.timeout` e `task.error`.

O envelope também aceita atividades adicionais do motor como strings, por
exemplo `subtask_started`, `subtask_delivered`, `subtask_verified`,
`subtask_blocked` e `model_escalated`. O consumidor deve validar o payload
específico quando tratar esses tipos.

O buffer mantém até 500 eventos por tarefa. Ao reconectar, o cliente deve
enviar a última sequência recebida. Ao receber `replay_unavailable`, deve
recarregar o detalhe da tarefa e outros dados necessários por REST.

Não há, neste contrato, evento específico de chat ou streaming de resposta.
