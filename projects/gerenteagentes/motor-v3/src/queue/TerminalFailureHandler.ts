import type { QueueMessage } from './QueueMessage.js'

/**
 * Contexto entregue quando uma mensagem não pode mais ser repetida
 * automaticamente e está prestes a ser enviada para a DLQ.
 */
export interface TerminalFailureContext {
  message: QueueMessage
  attempt: number
  reason: string
  error: Error
}

/**
 * Fronteira entre a infraestrutura da fila e o tratamento de domínio.
 *
 * A implementação deve ser idempotente: a mesma mensagem pode chegar mais de
 * uma vez durante recuperação de conexão ou reinício do processo.
 */
export interface TerminalFailureHandler {
  handle(context: TerminalFailureContext): Promise<void>
}

export type TerminalFailureMessageHandler =
  (context: TerminalFailureContext) => Promise<void>

/**
 * Direciona uma falha terminal pelo tipo da mensagem sem acoplar o consumidor
 * da fila a subtarefas, deploys ou qualquer outra regra de negócio.
 */
export class TerminalFailureRouter implements TerminalFailureHandler {
  private readonly handlers = new Map<string, TerminalFailureMessageHandler>()

  constructor(
    handlers: Readonly<Record<string, TerminalFailureMessageHandler>> = {},
    private readonly fallback?: TerminalFailureMessageHandler,
  ) {
    for (const [messageType, handler] of Object.entries(handlers)) {
      this.handlers.set(messageType, handler)
    }
  }

  async handle(context: TerminalFailureContext): Promise<void> {
    const handler = this.handlers.get(context.message.type) ?? this.fallback
    if (!handler) return
    await handler(context)
  }
}
