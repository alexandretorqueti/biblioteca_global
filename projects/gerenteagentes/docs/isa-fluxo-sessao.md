# Isa — gatilho de criação da sessão

## Fluxo observado no carregamento

O `AgentChat` executa seu `useEffect` de montagem em
`packages/ui/src/components/AgentChat.tsx` nesta ordem:

1. `client.recordVisit()` envia `POST /site-visit` (no app standalone,
   `POST /api/site-visit`). `IsaChatService.recordVisit` apenas grava os
   dados anônimos em `visitas_site`.
2. `client.startSession()` envia `POST /session` (ou `/api/session` no app
   standalone), com `{ chatKey: visitorKey }`. O controller delega para
   `IsaChatService.createSession`, que cria o registro em `chats` e grava uma
   saudação estática, mesmo sem mensagem do visitante.
3. `client.loadHistory()` envia `GET /chat/:id/history` (ou
   `/api/chat/:id/history`). Em `IsaChatService.getHistory`, o bloco
   `Garante session_key...` chama `this.bridge.resolveSession(...)` quando o
   chat ainda não tem `sessionKey`.
4. `IsaChatBridgeService.resolveSession` chama `POST /api/sessions` no BFF do
   OpenClaw. Esse é o gatilho que cria/materializa a sessão da Isa durante o
   acesso inicial à página.

O fluxo é configurado tanto em `projects/gerenteagentes/screens/IsaChatScreen.tsx`
quanto em `projects/isa-chat/src/App.tsx`, usando o cliente compartilhado de
`packages/api-client/src/agent-chat-client.ts`.

## Classificação dos eventos

| Evento | Endpoint | Deve criar sessão OpenClaw? |
| --- | --- | --- |
| Acesso/carregamento da página | `POST /site-visit` | Não. É somente telemetria da visita. |
| Abertura do widget sem mensagem | `POST /session` e `GET /chat/:id/history` | Não. Pode criar/recuperar o identificador local do chat, mas não uma sessão de agente. |
| Primeiro texto ou anexo enviado pelo cliente | `POST /chat/send` | Sim. É o início de contato efetivo. |
| Mensagens seguintes | `POST /chat/send` | Reutilizar a sessão já associada ao chat. |

O controller rejeita `POST /chat/send` sem `chatId` ou sem texto/anexo. No
serviço, o caminho de `sendMessage` persiste a mensagem e, no bloco
`Garante sessão no OpenClaw`, resolve a sessão antes de chamar
`this.bridge.send(...)`. Esse é o ponto correto para a primeira criação da
sessão após o contato.

## Correção indicada

O `getHistory` deve poder retornar o histórico de um chat sem
`sessionKey` e não deve chamar `resolveSession`. A resolução na ponte deve
ficar exclusivamente no envio de uma mensagem válida (ou em outro evento
explícito de contato), mantendo `recordVisit` e a abertura da página como
eventos sem sessão OpenClaw.

