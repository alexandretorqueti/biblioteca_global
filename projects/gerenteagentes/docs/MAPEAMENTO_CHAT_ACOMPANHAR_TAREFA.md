# Mapeamento — chat sequencial em “Acompanhar Tarefa”

**Subtarefa:** #1 · **Data do levantamento:** 2026-09-04  
**Tela:** `projects/gerenteagentes/screens/TaskMonitorScreen.tsx`  
**Registro no menu:** `projects/gerenteagentes/config.ts` → `componentId: gerenteagentes-task-monitor`; o registry de telas customizadas aponta esse id para `TaskMonitorScreen`.

## 1. Estrutura atual da tela

`TaskMonitorScreen` é uma tela custom React/MUI montada pelo `GeradorSistema`. Ela usa `useApi()` para obter o cliente HTTP autenticado e mantém a tarefa selecionada como `number | ""`; portanto, há uma única tarefa ativa por vez.

Fluxo e estado relevantes:

| Estado/fonte | Uso atual |
|---|---|
| `tarefas`, `projetos` | Combos de filtro e seleção; tarefas são atualizadas a cada 30 s e a seleção é preservada quando ainda existe. |
| `tarefaId` | Chave da tarefa ativa. A troca dispara limpeza/carregamento de detalhe, subtarefas, chat e recria o WebSocket. |
| `detail` | Retorno de `motor-detail`: existência no motor, status, subtarefas, subtarefa atual, eventos, erros e modelos. |
| `subtarefasDb` | `GET .../subtarefas`; fallback para preencher a grid quando o motor ainda não trouxe subtarefas e fonte dos IDs para edição. |
| `chat` | Array local de `TarefaChatMessage`; hoje é carregado por REST e renderizado como histórico simples. |
| `terminalEvents` | Até 500 envelopes recebidos pelo realtime; hoje só altera o status da tarefa quando recebe `task.status.changed`. |
| `realtimeStatus` | `connecting`, `open` ou `closed`, exibido no cabeçalho. |
| `erro` | Erro geral de detalhe/ações; carregamento do chat falha silenciosamente e vira lista vazia. |

Layout atual, em ordem:

1. Cabeçalho “Acompanhar Tarefa” e status da conexão realtime.
2. Filtros Projeto, Status e Tarefa.
3. Card da tarefa selecionada: título, edição, chips de status/tipo/progresso e ações iniciar/pausar/retomar.
4. Banners de tarefa ausente no motor, bloqueio e subtarefa ativa.
5. Para tipo diferente de `desenvolvimento`, um `Paper[data-testid="task-chat"]` com histórico somente leitura (“Entrega pelo chat”).
6. Para `desenvolvimento`, `Table[data-testid="subtask-table"]` com seq, título, escopo, critérios, status, workspace, entregas, edição e histórico de entregas expansível.
7. Feed de eventos do motor e diálogos de edição (tarefa/subtarefa) no restante do componente.

Consequência para a tarefa pai: o chat deve ser renderizado depois da grid (e não condicionado a `!isDesenvolvimento`), em um container de altura limitada com `overflow: auto`, campo de entrada e estados independentes de carregamento/envio/erro. A troca de `tarefaId` deve descartar mensagens otimistas e fechar a sessão/realtime anterior antes de carregar o novo histórico.

## 2. Endpoints REST do chat de tarefa

Todos os endpoints abaixo ficam sob `@Controller('gerenteagentes')`, usam `JwtAuthGuard`, `ProjectScopeGuard` e `RolesGuard`, e recebem o escopo do projeto pelo token. O `projetoId` não deve ser enviado no body.

### Histórico

`GET /api/gerenteagentes/tarefas/:id/chat` — leitura para todos os perfis autorizados.

Exemplo:

```http
GET /api/gerenteagentes/tarefas/42/chat
Authorization: Bearer <access-token-do-projeto>
```

Resposta atual: array direto, ordenado por `createdAt` ascendente (não `{ items: [...] }`).

```json
[
  {
    "id": 101,
    "tarefaId": 42,
    "role": "user",
    "texto": "Pode priorizar a validação do formulário?",
    "createdAt": "2026-09-04T12:00:00.000Z"
  },
  {
    "id": 102,
    "tarefaId": 42,
    "role": "analyst",
    "texto": "Sim, a validação será executada antes da persistência.",
    "createdAt": "2026-09-04T12:00:03.000Z"
  }
]
```

### Envio

`POST /api/gerenteagentes/tarefas/:id/chat` — escrita para `admin`, `gerente` e `operador`.

```http
POST /api/gerenteagentes/tarefas/42/chat
Authorization: Bearer <access-token-do-projeto>
Content-Type: application/json

{"role":"user","texto":"Pode priorizar a validação do formulário?"}
```

Resposta atual (`201`/resposta do controller):

```json
{
  "id": 103,
  "tarefaId": 42,
  "role": "user",
  "texto": "Pode priorizar a validação do formulário?",
  "createdAt": "2026-09-04T12:01:00.000Z"
}
```

O service verifica que a tarefa existe e grava em `tarefa_chats`. Os papéis documentados no schema são `user`, `assistant`, `system` e `analyst`; o controller atualmente não restringe/normaliza `role` nem valida texto vazio. Se a tarefa estiver em `awaiting_clarification`, uma mensagem `role: "user"` também é encaminhada ao motor para retomar a clarificação.

### Tabela relacionada

`chat_mensagens` é a tabela do chat de captação da Isa (`chats`), acessível pelos endpoints do `isa-chat` (`POST .../chat/session`, `POST .../chat/send`, `GET .../chat/:id/history`). Não é a persistência do chat de acompanhamento de tarefa. Para esta tela, a fonte correta é `tarefa_chats` via os dois endpoints acima.

## 3. WebSocket/realtime existente

O cliente é `packages/api-client/src/realtime.ts`, com `RealtimeClient`. Antes do handshake, ele solicita:

```http
GET /api/realtime/ticket
Authorization: Bearer <access-token>
```

Resposta: `{ "ticket": "<jwt-de-30s>" }`. Depois abre `WS /api/realtime/ws?ticket=<ticket>&taskId=42` e envia:

```json
{"type":"subscribe","channel":"task","taskId":42,"lastSequence":17}
```

Mensagens server-side tipadas por `packages/shared/src/realtime.ts`:

| Tipo | Conteúdo/uso |
|---|---|
| `subscribed` | Confirma tarefa e `currentSequence`. |
| `event` | Envelope `{ eventId, occurredAt, projectId, taskId, subtaskId?, type, payload, sequence }`. O buffer mantém até 500 eventos por tarefa. |
| `replay_unavailable` | O `lastSequence` ficou fora do buffer; exige recarga REST de detalhe/histórico. |
| `error` | Falha de inscrição (`INVALID_SUBSCRIPTION`) ou erro do gateway. |
| `pong` | Resposta ao `ping`. |

Tipos de evento de execução formalmente aceitos incluem `task.started`, `task.status.changed`, `task.command.started`, `task.command.output`, `task.command.finished`, `task.timeout` e `task.error`. O motor também publica envelopes com tipos adicionais de atividade (por exemplo `subtask_started`, `subtask_delivered`, `subtask_verified`, `subtask_blocked`, `model_escalated`), consumidos como strings pelo envelope genérico.

Não existe hoje evento WebSocket específico de mensagem de chat (`chat.message.created`, typing ou resposta parcial). Logo, o “tempo real” do chat deve reutilizar o POST + recarga/polling do histórico, ou exigir uma extensão contratual do realtime. A reconexão atual é automática (5 s se o ticket falhar; 1 s após fechamento), preservando `lastSequence`; ao receber `replay_unavailable`, a tela deve recarregar o detalhe e o histórico REST.

## 4. API e reutilização de `AgentChat`

`packages/ui/src/components/AgentChat.tsx` recebe a seguinte API:

```ts
interface AgentChatProps {
  agent: AgentInfo
  client: AgentChatDataSource
  welcomeMessage?: string
  placeholder?: string
  emptyMessage?: string
  offlineMessage?: string
  allowAttachments?: boolean
  acceptedFileTypes?: string
  historyRefreshIntervalMs?: number
  maxHeight?: number | string
  onNewConversation?: () => void
  newConversationLabel?: string
  status?: ReactNode
  renderHeader?: (agent: AgentInfo) => ReactNode
  renderMessage?: (message: ChatMessage) => ReactNode
  renderSidebar?: (context: { agent: AgentInfo; messages: ChatMessage[]; metadata?: Record<string, unknown> }) => ReactNode
}
```

Pode ser reutilizado diretamente para layout/UX: histórico rolável, auto-scroll que respeita scroll manual, bolhas por papel, estado “Digitando…”, input, envio otimista, anexos opcionais, refresh periódico, alerta de erro e altura máxima. Ele não conhece HTTP; recebe um `AgentChatDataSource` pronto.

Adaptações necessárias para o chat de tarefa:

- criar um adapter de `tarefa_chats` com `startSession`, `loadHistory` e `sendMessage`; não usar `createAgentChatClient` sem adaptação, pois o cliente padrão chama `/agent-chat/*`, usa sessão anônima e espera `chatId` string;
- converter IDs numéricos e campos `texto`/`createdAt` para `ChatMessage` (`id: String(id)`, `text: texto`, `role: analyst` → `agent` ou render customizado). O contrato genérico só aceita `agent | user | system`;
- não exibir saudação sintética de agente como conversa persistida, salvo decisão explícita do produto; `welcomeMessage` é local e o histórico de tarefa pode estar vazio;
- manter o adapter estável enquanto a tarefa permanece selecionada; limpar/substituir o adapter ao trocar `tarefaId`, impedir envio durante troca e reabrir a sessão/recarregar histórico após reconexão;
- como o endpoint de tarefa não envia resposta do agente em streaming nem evento de chat, `historyRefreshIntervalMs` é apenas fallback de polling. Para “respostas em tempo real” genuínas, adicionar evento de chat ao envelope realtime ou um bridge que publique quando `tarefa_chats` receber mensagem;
- tratar `404`, `401/403`, falha de histórico e falha de envio separadamente, preservando a mensagem otimista para retry somente quando a confirmação de persistência for desconhecida.

## 5. Fluxo recomendado para a integração

```text
selecionar tarefa
  → GET detalhe + GET subtarefas + GET tarefa/:id/chat
  → abrir WS da tarefa (eventos de execução)
  → renderizar grid
  → renderizar AgentChat abaixo da grid
  → POST mensagem → atualizar histórico/aguardar evento de chat
  → trocar tarefa: fechar WS, cancelar/ignorar respostas antigas, limpar estado e repetir
```

Os testes existentes em `projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx` já cobrem seleção, detalhe, grid, edição e compatibilidade do motor. A integração deve acrescentar casos de histórico vazio/carregado, envio, troca sem vazamento de mensagens, erro/retry e reconexão/replay indisponível; testes unitários de `AgentChat` e `RealtimeClient` já estão em `packages/ui/src/components/__tests__/AgentChat.test.tsx` e `packages/api-client/src/__tests__/realtime-client.spec.ts`.
