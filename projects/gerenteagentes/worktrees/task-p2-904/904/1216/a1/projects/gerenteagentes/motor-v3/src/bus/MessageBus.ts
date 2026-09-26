/**
 * MessageBus — coração do Motor-v3
 *
 * In-memory, síncrono, dentro do processo do motor. Futuro: broker externo (RabbitMQ/Kafka).
 * Garante ordem dentro de um mesmo tópico (taskId+subtaskId).
 *
 * Tipos de mensagem:
 * - evento: do sistema (erro, verificação, conclusão, estado)
 * - comando: da API HTTP (enqueue, pause, resume, etc)
 * - conversa: humano↔agente (chat, clarification)
 *
 * API:
 * - send(message)
 * - on(type, handler) / off(type, handler)
 * - subscribe(topic, handler) — garante ordem por chave
 */

export type MessageDirection = 'sent' | 'received' | 'event' | 'action'
export type MessageType = string

export interface Message {
  type: MessageType
  taskId: string
  subtaskId?: number
  executionId: string
  payload: Record<string, any>
  timestamp: string
  correlationId?: string
}

export type MessageHandler = (message: Message) => void | Promise<void>

export interface BusMiddleware {
  name: string
  onMessage?: (direction: MessageDirection, message: Message) => void | Promise<void>
}

export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>()
  private topicHandlers = new Map<string, Set<MessageHandler>>()
  private middlewares: BusMiddleware[] = []

  /**
   * Registra middleware (chamado antes/depois de cada mensagem).
   */
  use(middleware: BusMiddleware): void {
    this.middlewares.push(middleware)
  }

  /**
   * Registra handler para um tipo de mensagem.
   */
  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
    return () => this.off(type, handler)
  }

  /**
   * Remove handler.
   */
  off(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler)
  }

  /**
   * Registra handler para um tópico (taskId+subtaskId), garantindo ordem.
   * Útil para sequências que não podem embaralhar (ex: análise → execução da mesma tarefa).
   */
  subscribe(topic: string, handler: MessageHandler): () => void {
    if (!this.topicHandlers.has(topic)) {
      this.topicHandlers.set(topic, new Set())
    }
    this.topicHandlers.get(topic)!.add(handler)
    return () => this.topicHandlers.get(topic)?.delete(handler)
  }

  /**
   * Envia mensagem (síncrono, in-memory).
   * 1. Middlewares são notificados (sent).
   * 2. Handlers por type são chamados em ordem de registro.
   * 3. Handlers por topic (se houver) são chamados.
   * 4. Erro em um handler NÃO derruba os outros — é logado e segue.
   */
  async send(message: Message): Promise<void> {
    // 1. Middlewares (pré-dispatch)
    for (const mw of this.middlewares) {
      try {
        await mw.onMessage?.('sent', message)
      } catch (err) {
        console.error(`[MessageBus] Middleware ${mw.name} failed:`, err)
      }
    }

    // 2. Handlers por type
    const typeHandlers = this.handlers.get(message.type)
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(message)
        } catch (err) {
          console.error(`[MessageBus] Handler for ${message.type} failed:`, err)
        }
      }
    }

    // 3. Handlers por topic (taskId+subtaskId)
    const topic = this.buildTopic(message)
    const topicHandlers = this.topicHandlers.get(topic)
    if (topicHandlers) {
      for (const handler of topicHandlers) {
        try {
          await handler(message)
        } catch (err) {
          console.error(`[MessageBus] Topic handler for ${topic} failed:`, err)
        }
      }
    }

    // 4. Middlewares (pós-dispatch)
    for (const mw of this.middlewares) {
      try {
        await mw.onMessage?.('received', message)
      } catch (err) {
        console.error(`[MessageBus] Middleware ${mw.name} post-dispatch failed:`, err)
      }
    }
  }

  /**
   * Emite evento (atalho para send com type = EVENT_<name>).
   */
  async emit(eventName: string, payload: Omit<Message, 'type' | 'timestamp'>): Promise<void> {
    await this.send({
      ...payload,
      type: `EVENT_${eventName}`,
      timestamp: new Date().toISOString(),
    })
  }

  private buildTopic(message: Message): string {
    return `${message.taskId}:${message.subtaskId ?? 'task'}`
  }

  /**
   * Lista handlers registrados (para debug).
   */
  debug(): { typeHandlers: Record<string, number>; topicHandlers: Record<string, number> } {
    const typeHandlers: Record<string, number> = {}
    for (const [type, handlers] of this.handlers) {
      typeHandlers[type] = handlers.size
    }
    const topicHandlers: Record<string, number> = {}
    for (const [topic, handlers] of this.topicHandlers) {
      topicHandlers[topic] = handlers.size
    }
    return { typeHandlers, topicHandlers }
  }

  /**
   * Limpa todos os handlers (para testes).
   */
  reset(): void {
    this.handlers.clear()
    this.topicHandlers.clear()
    this.middlewares = []
  }
}
