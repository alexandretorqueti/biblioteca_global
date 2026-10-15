import { Inject, Injectable, Logger } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket } from "@nestjs/websockets"
import type { IncomingMessage } from "node:http"
import type { WebSocket } from "ws"
import { realtimeClientMessageSchema, type RealtimeClientMessage, type AgentMapSnapshot, type HelpDeskRealtimeSnapshot } from "@biblioteca-global/shared"
import { AUTH_REPOSITORY, type AuthRepository } from "../auth/auth.repository"
import { RealtimeService } from "./realtime.service"

interface SocketSession { projetoId: number; usuarioId: number }

export type MapSnapshotProvider = (projectId: number) => Promise<AgentMapSnapshot> | AgentMapSnapshot
export type HelpDeskSnapshotProvider = (input: { sessionId: number; userId: number; projectId: number }) => Promise<HelpDeskRealtimeSnapshot | null> | HelpDeskRealtimeSnapshot | null

@Injectable()
@WebSocketGateway({ path: "/api/realtime/ws" })
export class RealtimeGateway {
  private readonly logger = new Logger(RealtimeGateway.name)
  private readonly sessoes = new WeakMap<WebSocket, SocketSession>()
  private mapSnapshotProvider: MapSnapshotProvider | null = null
  private helpDeskSnapshotProvider: HelpDeskSnapshotProvider | null = null

  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AUTH_REPOSITORY) private readonly authRepository: AuthRepository,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  setMapSnapshotProvider(provider: MapSnapshotProvider | null): void {
    this.mapSnapshotProvider = provider
  }

  setHelpDeskSnapshotProvider(provider: HelpDeskSnapshotProvider | null): void {
    this.helpDeskSnapshotProvider = provider
    this.realtime.setHelpDeskSnapshotProvider(provider)
  }

  async handleConnection(client: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost")
      const ticket = url.searchParams.get("ticket")
      const cookieToken = this.cookie(request.headers.cookie, "bg_access_token")
      const token = ticket ?? cookieToken
      if (!token) throw new Error("ticket ou cookie ausente")
      const claims = await this.jwt.verifyAsync<Record<string, unknown>>(token)
      if (typeof claims.sub !== "number" || typeof claims.projetoId !== "number") throw new Error("claims inválidos")
      // Ticket WebSocket: exige kind="ws-ticket" (rejeita access tokens normais).
      // Access token normal: não tem kind, aceita via cookie (dev local).
      const temTicket = ticket != null
      const kindOk = temTicket ? claims.kind === "ws-ticket" : claims.kind == null
      if (!kindOk) throw new Error("tipo de token incorreto")
      const scope = await this.authRepository.resolveScope(claims.sub as number, claims.projetoId as number)
      if (!scope) throw new Error("escopo inválido")
      this.sessoes.set(client, { projetoId: claims.projetoId as number, usuarioId: claims.sub as number })
    } catch {
      this.logger.warn("Conexão realtime rejeitada")
      client.close(1008, "Não autorizado")
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.realtime.remover(client)
    this.sessoes.delete(client)
  }

  @SubscribeMessage("subscribe")
  async subscribe(@ConnectedSocket() client: WebSocket, @MessageBody() raw: unknown): Promise<void> {
    const session = this.sessoes.get(client)
    const parsed = realtimeClientMessageSchema.safeParse(raw)
    if (!session || !parsed.success || parsed.data.type !== "subscribe") {
      client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Inscrição inválida" }))
      return
    }
    const message: RealtimeClientMessage = parsed.data
    if (session.projetoId <= 0) {
      client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Tarefa inválida" }))
      return
    }
    if (message.channel === "project-feed") {
      const result = this.realtime.inscreverFeed(session.projetoId, client, message.lastSequence)
      if (!result.replayAvailable) {
        client.send(JSON.stringify({ type: "feed_replay_unavailable", currentSequence: result.currentSequence }))
      }
      client.send(JSON.stringify({ type: "feed_subscribed", currentSequence: result.currentSequence }))
      return
    }
    if (message.channel === "map") {
      void this.handleMapSubscription(client, session.projetoId, message.lastSequence)
      return
    }
    if (message.channel === "task") {
      if (!message.taskId || message.taskId <= 0) {
        client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Tarefa inválida" }))
        return
      }
      const result = this.realtime.inscrever(message.taskId, session.projetoId, client, message.lastSequence)
      if (!result.replayAvailable) {
        client.send(JSON.stringify({ type: "replay_unavailable", taskId: message.taskId, currentSequence: result.currentSequence }))
      }
      client.send(JSON.stringify({ type: "subscribed", taskId: message.taskId, currentSequence: result.currentSequence }))
      return
    }
    if (message.channel === "helpdesk") {
      if (!message.sessaoId) {
        client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Sessão HelpDesk inválida" }))
        return
      }
      const snapshot = await this.realtime.obterHelpDeskSnapshot({ sessionId: message.sessaoId, userId: session.usuarioId, projectId: session.projetoId })
      if (!snapshot || snapshot.usuarioId !== session.usuarioId || snapshot.projetoId !== session.projetoId || snapshot.sessaoId !== message.sessaoId) {
        client.send(JSON.stringify({ type: "error", code: "FORBIDDEN_SUBSCRIPTION", message: "Sessão HelpDesk não pertence ao escopo autenticado" }))
        return
      }
      const result = this.realtime.inscreverHelpDesk(session.projetoId, session.usuarioId, message.sessaoId, client, snapshot, message.lastSequence)
      if (!result.replayAvailable) client.send(JSON.stringify({ type: "helpdesk_replay_unavailable", sessaoId: message.sessaoId, currentSequence: result.currentSequence }))
      client.send(JSON.stringify({ type: "helpdesk_subscribed", sessaoId: message.sessaoId, currentSequence: result.currentSequence }))
      return
    }
    client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Canal inválido" }))
  }

  private async handleMapSubscription(client: WebSocket, projectId: number, lastSequence?: number): Promise<void> {
    if (!this.mapSnapshotProvider) {
      client.send(JSON.stringify({ type: "error", code: "MAP_SNAPSHOT_UNAVAILABLE", message: "Snapshot do mapa indisponível" }))
      return
    }
    try {
      const snapshot = await this.mapSnapshotProvider(projectId)
      const result = this.realtime.inscreverMapa(projectId, client, snapshot, lastSequence)
      if (!result.replayAvailable) {
        client.send(JSON.stringify({ type: "map_replay_unavailable", projectId, currentSequence: result.currentSequence }))
      }
      client.send(JSON.stringify({ type: "map_subscribed", projectId, currentSequence: result.currentSequence }))
    } catch {
      client.send(JSON.stringify({ type: "error", code: "MAP_SNAPSHOT_FAILED", message: "Falha ao obter snapshot do mapa" }))
    }
  }

  @SubscribeMessage("ping")
  ping(@ConnectedSocket() client: WebSocket): void {
    client.send(JSON.stringify({ type: "pong" }))
  }

  private cookie(header: string | undefined, name: string): string | undefined {
    return header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1)
  }
}
