import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import type { WebSocket } from "ws"
import { realtimeIngressEventSchema, type AgentMapSnapshot, type RealtimeServerMessage, type TaskEventEnvelope, type RealtimeIngressEvent, type TaskDetailSnapshot, type HelpDeskRealtimeSnapshot, type HelpDeskRealtimeMessage } from "@biblioteca-global/shared"

const LIMITE_EVENTOS_POR_TAREFA = 500
const LIMITE_EVENTOS_HELPDESK = 500

@Injectable()
export class RealtimeService {
  // TODO(security): definir política de expiração/limpeza dos buffers e
  // limite de conexões para evitar crescimento de memória (demanda registrada).
  private readonly sequencias = new Map<number, number>()
  private readonly eventos = new Map<string, TaskEventEnvelope[]>()
  private readonly eventosPorProjeto = new Map<number, TaskEventEnvelope[]>()
  private readonly inscritos = new Map<string, Map<WebSocket, number>>()
  private readonly inscritosFeed = new Map<number, Map<WebSocket, number>>()
  private readonly inscritosMapa = new Map<number, Map<WebSocket, number>>()
  private readonly eventosRecebidos = new Set<string>()
  private readonly envelopesPorId = new Map<string, TaskEventEnvelope>()
  private helpDeskSnapshotProvider: ((input: { sessionId: number; userId: number; projectId: number }) => Promise<HelpDeskRealtimeSnapshot | null> | HelpDeskRealtimeSnapshot | null) | null = null
  private readonly helpdeskSequencias = new Map<string, number>()
  private readonly helpdeskEventos = new Map<string, Array<{ eventId: string; sequence: number; occurredAt: string; type: "helpdesk.message.created" | "helpdesk.processing.changed"; payload: Record<string, unknown> }>>()
  private readonly helpdeskInscritos = new Map<string, Map<WebSocket, number>>()

  publicar(evento: unknown): TaskEventEnvelope {
    const parsed = realtimeIngressEventSchema.safeParse(evento)
    if (!parsed.success) throw new Error("Evento realtime inválido")
    const input: RealtimeIngressEvent = parsed.data
    const anterior = this.envelopesPorId.get(input.eventId)
    if (anterior) return anterior
    // A entrada é idempotente por eventId. O conjunto também protege contra
    // uma segunda entrega enquanto o envelope ainda está sendo indexado.
    if (!this.aceitarUmaVez(input.eventId)) throw new Error("Evento realtime duplicado")
    const atual = this.sequencias.get(input.projectId) ?? 0
    const envelope: TaskEventEnvelope = {
      ...input,
      sequence: atual + 1,
    }
    this.sequencias.set(envelope.projectId, envelope.sequence)
    this.envelopesPorId.set(envelope.eventId, envelope)
    const chave = this.chave(envelope.projectId, envelope.taskId)
    const lista = this.eventos.get(chave) ?? []
    lista.push(envelope)
    if (lista.length > LIMITE_EVENTOS_POR_TAREFA) lista.splice(0, lista.length - LIMITE_EVENTOS_POR_TAREFA)
    this.eventos.set(chave, lista)
    this.enviar(chave, { type: "event", event: envelope })
    const feed = this.eventosPorProjeto.get(envelope.projectId) ?? []
    feed.push(envelope)
    if (feed.length > LIMITE_EVENTOS_POR_TAREFA * 10) feed.splice(0, feed.length - LIMITE_EVENTOS_POR_TAREFA * 10)
    this.eventosPorProjeto.set(envelope.projectId, feed)
    this.enviarFeed(envelope.projectId, { type: "event", event: envelope })
    this.enviarMapa(envelope.projectId, { type: "event", event: envelope })
    return envelope
  }

  aceitarUmaVez(eventId: string): boolean {
    if (this.eventosRecebidos.has(eventId)) return false
    this.eventosRecebidos.add(eventId)
    return true
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
    for (const [projectId, inscritos] of this.inscritosFeed) {
      inscritos.delete(client)
      if (inscritos.size === 0) this.inscritosFeed.delete(projectId)
    }
    for (const [projectId, inscritos] of this.inscritosMapa) {
      inscritos.delete(client)
      if (inscritos.size === 0) this.inscritosMapa.delete(projectId)
    }
    for (const [key, inscritos] of this.helpdeskInscritos) {
      inscritos.delete(client)
      if (inscritos.size === 0) this.helpdeskInscritos.delete(key)
    }
  }

  inscreverHelpDesk(projectId: number, userId: number, sessionId: number, client: WebSocket, snapshot: HelpDeskRealtimeSnapshot, lastSequence?: number): { currentSequence: number; replayAvailable: boolean } {
    const key = this.helpDeskKey(projectId, userId, sessionId)
    const inscritos = this.helpdeskInscritos.get(key) ?? new Map<WebSocket, number>()
    inscritos.set(client, userId)
    this.helpdeskInscritos.set(key, inscritos)
    const atual = this.helpdeskSequencias.get(key) ?? 0
    this.enviarPara(client, { type: "helpdesk_snapshot", sessaoId: sessionId, currentSequence: atual, snapshot })
    const lista = this.helpdeskEventos.get(key) ?? []
    if (lastSequence !== undefined) {
      const primeiro = lista[0]?.sequence
      if (primeiro !== undefined && lastSequence < primeiro - 1) return { currentSequence: atual, replayAvailable: false }
      for (const event of lista) if (event.sequence > lastSequence) this.enviarPara(client, { type: "event", event: { ...event, projectId, taskId: sessionId, source: "helpdesk", organizationId: undefined } })
    }
    return { currentSequence: atual, replayAvailable: true }
  }

  publicarHelpDesk(input: { projectId: number; userId: number; sessionId: number; type: "helpdesk.message.created" | "helpdesk.processing.changed"; payload: Record<string, unknown> }): void {
    const key = this.helpDeskKey(input.projectId, input.userId, input.sessionId)
    const event = { eventId: randomUUID(), sequence: (this.helpdeskSequencias.get(key) ?? 0) + 1, occurredAt: new Date().toISOString(), type: input.type, payload: input.payload }
    this.helpdeskSequencias.set(key, event.sequence)
    const lista = this.helpdeskEventos.get(key) ?? []
    lista.push(event)
    if (lista.length > LIMITE_EVENTOS_HELPDESK) lista.splice(0, lista.length - LIMITE_EVENTOS_HELPDESK)
    this.helpdeskEventos.set(key, lista)
    for (const client of this.helpdeskInscritos.get(key)?.keys() ?? []) {
      this.enviarPara(client, { type: "event", event: { ...event, projectId: input.projectId, taskId: input.sessionId, source: "helpdesk", organizationId: undefined } })
    }
  }

  setHelpDeskSnapshotProvider(provider: ((input: { sessionId: number; userId: number; projectId: number }) => Promise<HelpDeskRealtimeSnapshot | null> | HelpDeskRealtimeSnapshot | null) | null): void {
    this.helpDeskSnapshotProvider = provider
  }

  obterHelpDeskSnapshot(input: { sessionId: number; userId: number; projectId: number }): Promise<HelpDeskRealtimeSnapshot | null> | HelpDeskRealtimeSnapshot | null {
    return this.helpDeskSnapshotProvider?.(input) ?? null
  }

  inscreverFeed(projectId: number, client: WebSocket, lastSequence?: number): { currentSequence: number; replayAvailable: boolean } {
    const inscritos = this.inscritosFeed.get(projectId) ?? new Map<WebSocket, number>()
    inscritos.set(client, projectId)
    this.inscritosFeed.set(projectId, inscritos)
    const lista = this.eventosPorProjeto.get(projectId) ?? []
    const atual = this.sequencias.get(projectId) ?? 0
    if (lastSequence !== undefined) {
      const primeiro = lista[0]?.sequence
      if (primeiro !== undefined && lastSequence < primeiro - 1) return { currentSequence: atual, replayAvailable: false }
      for (const event of lista) if (event.sequence > lastSequence) this.enviarPara(client, { type: "event", event })
    }
    return { currentSequence: atual, replayAvailable: true }
  }

  inscreverMapa(projectId: number, client: WebSocket, snapshot: AgentMapSnapshot, lastSequence?: number): { currentSequence: number; replayAvailable: boolean } {
    const inscritos = this.inscritosMapa.get(projectId) ?? new Map<WebSocket, number>()
    inscritos.set(client, projectId)
    this.inscritosMapa.set(projectId, inscritos)
    const lista = this.eventosPorProjeto.get(projectId) ?? []
    const atual = this.sequencias.get(projectId) ?? 0
    // Envia snapshot inicial imediatamente
    this.enviarPara(client, { type: "map_snapshot", projectId, currentSequence: atual, snapshot })
    if (lastSequence !== undefined) {
      const primeiro = lista[0]?.sequence
      if (primeiro !== undefined && lastSequence < primeiro - 1) return { currentSequence: atual, replayAvailable: false }
      for (const event of lista) if (event.sequence > lastSequence) this.enviarPara(client, { type: "event", event })
    }
    return { currentSequence: atual, replayAvailable: true }
  }

  obterSnapshotDetalhe(taskId: number, projectId: number, snapshot: TaskDetailSnapshot): void {
    // Envia snapshot de detalhe para todos os inscritos na tarefa específica
    const chave = this.chave(projectId, taskId)
    for (const client of this.inscritos.get(chave)?.keys() ?? []) {
      const atual = this.sequencias.get(projectId) ?? 0
      this.enviarPara(client, { type: "task_snapshot", taskId: taskId, currentSequence: atual, snapshot })
    }
  }

  private chave(projectId: number, taskId: number): string {
    return `${projectId}:${taskId}`
  }

  private helpDeskKey(projectId: number, userId: number, sessionId: number): string {
    return `${projectId}:${userId}:${sessionId}`
  }

  private enviar(chave: string, message: RealtimeServerMessage): void {
    for (const client of this.inscritos.get(chave)?.keys() ?? []) this.enviarPara(client, message)
  }

  private enviarFeed(projectId: number, message: RealtimeServerMessage): void {
    for (const client of this.inscritosFeed.get(projectId)?.keys() ?? []) this.enviarPara(client, message)
  }

  private enviarMapa(projectId: number, message: RealtimeServerMessage): void {
    for (const client of this.inscritosMapa.get(projectId)?.keys() ?? []) this.enviarPara(client, message)
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
