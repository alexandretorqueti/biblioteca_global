import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import type { WebSocket } from "ws"
import { taskEventEnvelopeSchema, type RealtimeServerMessage, type TaskEventEnvelope } from "@biblioteca-global/shared"

const LIMITE_EVENTOS_POR_TAREFA = 500

@Injectable()
export class RealtimeService {
  // TODO(security): definir política de expiração/limpeza dos buffers e
  // limite de conexões para evitar crescimento de memória (demanda registrada).
  private readonly sequencias = new Map<number, number>()
  private readonly eventos = new Map<string, TaskEventEnvelope[]>()
  private readonly inscritos = new Map<string, Map<WebSocket, number>>()

  publicar(evento: unknown): TaskEventEnvelope {
    const parsed = taskEventEnvelopeSchema.safeParse(evento)
    if (!parsed.success) throw new Error("Evento realtime inválido")
    const atual = this.sequencias.get(parsed.data.projectId) ?? 0
    const envelope: TaskEventEnvelope = {
      ...parsed.data,
      sequence: atual + 1,
    }
    this.sequencias.set(envelope.projectId, envelope.sequence)
    const chave = this.chave(envelope.projectId, envelope.taskId)
    const lista = this.eventos.get(chave) ?? []
    lista.push(envelope)
    if (lista.length > LIMITE_EVENTOS_POR_TAREFA) lista.splice(0, lista.length - LIMITE_EVENTOS_POR_TAREFA)
    this.eventos.set(chave, lista)
    this.enviar(chave, { type: "event", event: envelope })
    return envelope
  }

  inscrever(taskId: number, projectId: number, client: WebSocket, lastSequence?: number): { currentSequence: number; replayAvailable: boolean } {
    const chave = this.chave(projectId, taskId)
    const inscritos = this.inscritos.get(chave) ?? new Map<WebSocket, number>()
    inscritos.set(client, projectId)
    this.inscritos.set(chave, inscritos)
    const lista = this.eventos.get(chave) ?? []
    const atual = this.sequencias.get(projectId) ?? 0
    if (lastSequence !== undefined) {
      const primeiro = lista[0]?.sequence
      if (primeiro !== undefined && lastSequence < primeiro - 1) return { currentSequence: atual, replayAvailable: false }
      for (const event of lista) if (event.projectId === projectId && event.sequence > lastSequence) this.enviarPara(client, { type: "event", event })
    }
    return { currentSequence: atual, replayAvailable: true }
  }

  remover(client: WebSocket): void {
    for (const [taskId, inscritos] of this.inscritos) {
      inscritos.delete(client)
      if (inscritos.size === 0) this.inscritos.delete(taskId)
    }
  }

  private chave(projectId: number, taskId: number): string {
    return `${projectId}:${taskId}`
  }

  private enviar(chave: string, message: RealtimeServerMessage): void {
    for (const client of this.inscritos.get(chave)?.keys() ?? []) this.enviarPara(client, message)
  }

  private enviarPara(client: WebSocket, message: RealtimeServerMessage): void {
    if (client.readyState === 1) client.send(JSON.stringify(message))
  }

  criarEnvelope(input: Omit<TaskEventEnvelope, "eventId" | "sequence" | "occurredAt"> & { occurredAt?: string }): TaskEventEnvelope {
    return {
      ...input,
      eventId: randomUUID(),
      sequence: 1,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    }
  }
}
