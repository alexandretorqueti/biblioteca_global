# Chat da tarefa no realtime — causa raiz

## Causas

- **A — roteamento da API:** o evento precisa usar o `projectId` do tenant do
  Motor (`MOTOR_REALTIME_TENANT_PROJECT_ID`, com padrão `640`) para alcançar o
  canal realtime da Biblioteca. O `managedProjectId` identifica o projeto
  gerenciado da tarefa quando essa identidade está disponível.
- **B — ausência de publicação no motor:** mensagens gravadas em
  `tarefa_chats` não geravam uma linha em `realtime_event_outbox`. O Motor v3
  agora grava `task.chat.message.created` com id numérico, role, texto e
  `createdAt` ISO, usando a mesma transação quando o insert já é transacional.

## Regra permanente

Todo `INSERT` em `tarefa_chats` deve gerar exatamente um evento
`task.chat.message.created` roteado pelo tenant. O evento deve ser gravado no
outbox; a entrega ao ingresso realtime permanece responsabilidade do
`RealtimeOutboxDispatcher`, depois do commit, sem chamada de rede no consumidor.
