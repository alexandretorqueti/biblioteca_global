# Contrato realtime do Mapa Vivo da Operação

Este documento formaliza o contrato entre o acompanhamento de tarefas e o
realtime da Biblioteca. O mapa é uma projeção de fatos operacionais; ele não
altera status e não deve inventar transições quando receber um evento
desconhecido.

## 1. Ciclo de sincronização

1. A tela carrega o snapshot por `GET /gerenteagentes/tarefas-com-status`.
2. Depois abre o WebSocket de tarefa selecionada com `RealtimeClient`.
3. Eventos válidos atualizam somente o estado local que o envelope consegue
   representar. Mudanças de subtarefa disparam a recarga do detalhe da tarefa.
4. O polling periódico permanece como reconciliação para tarefas que não são a
   tarefa selecionada. Ele não substitui o processamento do WebSocket.
5. Ao trocar a tarefa selecionada, o cliente fecha a inscrição anterior antes
   de aceitar eventos da nova tarefa.

O snapshot HTTP é a fonte de recuperação. O realtime é uma notificação
ordenada, não uma fonte independente de verdade.

## 2. Inscrição e envelope

O cliente solicita um ticket HTTP autenticado e abre:

```text
WS /api/realtime/ws?ticket=<ticket>&taskId=<id>
```

Após a abertura, envia uma inscrição com o último número recebido:

```json
{"type":"subscribe","channel":"task","taskId":42,"lastSequence":17}
```

O envelope de evento tem este formato estável:

```json
{
  "eventId": "uuid",
  "occurredAt": "2026-09-12T12:00:00.000Z",
  "projectId": 7,
  "taskId": 42,
  "subtaskId": 1059,
  "type": "task.status.changed",
  "payload": {},
  "sequence": 18
}
```

`eventId` identifica o evento para deduplicação, `sequence` ordena eventos da
tarefa e `occurredAt` é o instante de ocorrência no produtor. `subtaskId` é
opcional. O cliente deve tolerar campos adicionais no payload.

Mensagens de controle não são eventos do mapa: `subscribed`, `pong`, `error`
e `replay_unavailable`. Em `replay_unavailable`, recarregar o snapshot/detalhe
HTTP antes de continuar consumindo novos eventos.

## 3. Eventos consumidos pelo mapa

| Evento | Payload mínimo | Projeção |
|---|---|---|
| `task.created` | `id`, `titulo` ou `title`, `status`, `projetoId` ou `projectId` | Insere a tarefa; campos ausentes ficam nulos/compatíveis com o snapshot. |
| `task.updated` | `id` e campos alterados | Mescla somente os campos presentes, preservando os demais. |
| `task.status.changed` | `status` | Move a tarefa de estação e registra a animação de deslocamento. |
| `task.deleted` | nenhum | Remove a tarefa e limpa a seleção se ela era a selecionada. |
| `subtask.*` | `subtaskId` quando disponível | Recarrega detalhe e subtarefas para recalcular progresso/status derivados. |

`taskId` do envelope é a identidade canônica da tarefa. `payload.id` pode ser
usado somente quando o evento é `task.created`/`task.updated`; se os dois
divergirem, prevalece `taskId` e o cliente deve solicitar reconciliação.

## 4. Regras da projeção visual

- A estação é determinada pelo status efetivo da tarefa.
- `paused` sem subtarefas é exibida em `Rascunhos`; `paused` com subtarefas,
  em `Aguardando`.
- `blocked` e `failed` ficam em `Atenção`; `motor_fix` fica em `Correção do
  motor`.
- A prioridade, quando necessária para filtros e borda do card, é derivada do
  status; não é um campo aceito pelo evento realtime.
- Métricas, contagens por estação e filtros são recalculados a partir da lista
  resultante, nunca incrementados cegamente pelo evento.
- Um evento duplicado (`eventId` já aplicado) não pode duplicar card, atividade
  ou mensagem.
- Um evento fora de ordem não pode sobrescrever estado mais novo; em caso de
  dúvida de sequência, reconciliar por HTTP.

## 5. Falhas, reconexão e compatibilidade

- `error` mantém o último snapshot válido e exibe o estado de conexão; não
  remove tarefas localmente.
- Fechamento do socket inicia a reconexão automática do cliente. O mapa pode
  continuar exibindo o snapshot enquanto estiver desconectado.
- Falha do ticket ou `replay_unavailable` exige nova leitura HTTP antes de
  considerar a projeção atualizada.
- Tipos de evento desconhecidos são preservados no feed terminal, mas
  ignorados pela projeção do mapa.
- O servidor deve publicar `task.status.changed` após persistir o fato que
  determinou o novo status. O consumidor não deve assumir que a chegada do
  evento significa que todos os detalhes derivados já estão disponíveis; para
  isso usa a reconciliação HTTP.

## 6. Escopo e evolução

Este contrato cobre o mapa de tarefas, não o chat da tarefa. Eventos de chat,
streaming de resposta e presença exigem contrato separado. A expansão para
uma assinatura global do mapa deve manter o mesmo envelope e as mesmas regras
de sequência, trocando apenas o escopo da inscrição.
