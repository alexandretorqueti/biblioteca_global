# Isa — fluxo esperado de sessões

## Regra principal

O acesso inicial ao site, o carregamento do widget e a leitura do histórico
**não criam uma sessão da Isa no OpenClaw**. Uma visita pode ser registrada em
`visitas_site` para telemetria e o frontend pode manter um `visitorKey`, mas
isso não é contato do cliente e não deve chamar `POST /api/sessions` no BFF.

Essa regra vale também quando o visitante abre o widget e não envia nada:
nenhuma sessão de agente deve ser materializada apenas porque a página foi
acessada.

## Evento que cria a sessão

Contato do cliente é o primeiro envio válido de **texto ou anexo** pelo
endpoint `POST /chat/send` (ou a rota equivalente `/api/chat/send`). O
controller exige `chatId` e pelo menos um texto não vazio ou anexo. Depois dessa
validação, `IsaChatService.sendMessage` deve:

1. persistir a mensagem do cliente;
2. criar/materializar a sessão no OpenClaw com `bridge.resolveSession(...)`, se
   o chat ainda não tiver `sessionKey`;
3. enviar a mensagem para essa sessão com `bridge.send(...)`;
4. persistir no chat o `sessionKey` retornado.

O `POST /session` usado para materializar o chat local é permitido como parte
desse primeiro envio, mas, no modo anônimo, não deve resolver uma sessão no
OpenClaw nem chamar a Isa antes de existir uma mensagem do cliente.

## Reutilização durante a conversa

O `sessionKey` pertence ao chat e é a referência da conversa com a Isa. Após a
primeira mensagem, cada novo `POST /chat/send` deve reutilizar esse valor e
enviar a mensagem à mesma sessão. Não se deve criar uma sessão nova por
visita, abertura do widget, `GET /chat/:id/history` ou mensagem subsequente.

Uma nova resolução só é válida quando o chat ainda não possui `sessionKey` ou
quando há uma troca explícita de agente (`agentId`) que exija uma sessão
compatível. Nessa situação, o novo valor deve substituir o anterior no chat e
ser usado para os envios seguintes.

## Classificação dos eventos

| Evento | Endpoint | Comportamento esperado |
| --- | --- | --- |
| Acesso/carregamento da página | `POST /site-visit` | Registrar visita; não criar sessão OpenClaw. |
| Abertura do widget sem mensagem | `POST /session` e/ou `GET /chat/:id/history` | Criar/recuperar apenas o chat local; não criar sessão da Isa. |
| Primeiro texto ou anexo válido | `POST /chat/send` | Criar a sessão OpenClaw, associar `sessionKey` e enviar a mensagem. |
| Mensagens seguintes | `POST /chat/send` | Reutilizar o `sessionKey` associado ao chat. |

O cliente compartilhado em `packages/api-client/src/agent-chat-client.ts` deve
manter o histórico inicial sem materializar sessão e iniciar o chat somente no
primeiro envio. O serviço de histórico deve ser somente leitura em relação à
sessão: não deve chamar `resolveSession` para chats sem `sessionKey`.
