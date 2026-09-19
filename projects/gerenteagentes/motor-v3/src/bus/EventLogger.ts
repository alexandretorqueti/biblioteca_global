/**
 * EventLogger — middleware de observabilidade para o MessageBus
 *
 * Log estruturado de cada mensagem que passa:
 * [ENVIADA]/[RECEBIDA]/[EVENTO]/[AÇÃO] | taskId | subtaskId | type | correlationId
 *
 * Sinks:
 * - stdout (console.log estruturado)
 * - (futuro) tabela motor_event_log via DrizzleDb
 *
 * Cada entrada carrega: taskId, subtaskId, model, generation, timestamp, correlationId.
 */

import type { BusMiddleware, Message, MessageDirection } from '../bus/MessageBus.js'

export interface LogEntry {
  direction: MessageDirection
  messageType: string
  tarefaId: string | null
  subtarefaId: number | null
  model: string | null
  generation: number | null
  correlationId: string | null
  payload: Record<string, any>
  createdAt: Date
}

export type LogSink = (entry: LogEntry) => void | Promise<void>

export class EventLogger implements BusMiddleware {
  readonly name = 'EventLogger'
  private entries: LogEntry[] = []
  private sinks: LogSink[] = []

  constructor(sinks: LogSink[] = []) {
    this.sinks = sinks
    // Sink padrão: stdout estruturado
    this.sinks.push(this.stdoutSink.bind(this))
  }

  async onMessage(direction: MessageDirection, message: Message): Promise<void> {
    const entry: LogEntry = {
      direction,
      messageType: message.type,
      tarefaId: message.taskId ?? null,
      subtarefaId: message.subtaskId ?? null,
      model: (message.payload?.model as string) ?? null,
      generation: (message.payload?.generation as number) ?? null,
      correlationId: message.correlationId ?? null,
      payload: message.payload,
      createdAt: new Date(message.timestamp),
    }

    this.entries.push(entry)

    for (const sink of this.sinks) {
      try {
        await sink(entry)
      } catch (err) {
        console.error('[EventLogger] Sink failed:', err)
      }
    }
  }

  private stdoutSink(entry: LogEntry): void {
    const dir = this.directionLabel(entry.direction)
    const sub = entry.subtarefaId ? ` sub=${entry.subtarefaId}` : ''
    const corr = entry.correlationId ? ` corr=${entry.correlationId.slice(0, 8)}` : ''
    const model = entry.model ? ` model=${entry.model}` : ''
    const gen = entry.generation != null ? ` gen=${entry.generation}` : ''
    console.log(`[${dir}] ${entry.messageType} | task=${entry.tarefaId ?? '-'}${sub}${model}${gen}${corr}`)
  }

  private directionLabel(direction: MessageDirection): string {
    switch (direction) {
      case 'sent': return 'ENVIADA'
      case 'received': return 'RECEBIDA'
      case 'event': return 'EVENTO'
      case 'action': return 'AÇÃO'
    }
  }

  /**
   * Retorna todas as entradas de log (para testes e debug).
   */
  getEntries(): readonly LogEntry[] {
    return this.entries
  }

  /**
   * Filtra entradas por direction.
   */
  byDirection(direction: MessageDirection): LogEntry[] {
    return this.entries.filter(e => e.direction === direction)
  }

  /**
   * Filtra entradas por messageType.
   */
  byType(messageType: string): LogEntry[] {
    return this.entries.filter(e => e.messageType === messageType)
  }

  /**
   * Filtra entradas por tarefaId.
   */
  byTask(tarefaId: string): LogEntry[] {
    return this.entries.filter(e => e.tarefaId === tarefaId)
  }

  /**
   * Limpa entradas (para testes).
   */
  clear(): void {
    this.entries = []
  }

  /**
   * Adiciona sink customizado.
   */
  addSink(sink: LogSink): void {
    this.sinks.push(sink)
  }
}
