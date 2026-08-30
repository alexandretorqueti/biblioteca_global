import { Inject, Injectable, Logger } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket } from "@nestjs/websockets"
import type { IncomingMessage } from "node:http"
import type { WebSocket } from "ws"
import { realtimeClientMessageSchema, type RealtimeClientMessage } from "@biblioteca-global/shared"
import { AUTH_REPOSITORY, type AuthRepository } from "../auth/auth.repository"
import { RealtimeService } from "./realtime.service"

interface SocketSession { projetoId: number }

@Injectable()
@WebSocketGateway({ path: "/api/realtime/ws" })
export class RealtimeGateway {
  private readonly logger = new Logger(RealtimeGateway.name)
  private readonly sessoes = new WeakMap<WebSocket, SocketSession>()

  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AUTH_REPOSITORY) private readonly authRepository: AuthRepository,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

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
      this.sessoes.set(client, { projetoId: claims.projetoId as number })
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
  subscribe(@ConnectedSocket() client: WebSocket, @MessageBody() raw: unknown): void {
    // TODO(security): validar a existência/permissão da tarefa no projeto
    // antes de aceitar a inscrição (demanda registrada).
    const session = this.sessoes.get(client)
    const parsed = realtimeClientMessageSchema.safeParse(raw)
    if (!session || !parsed.success || parsed.data.type !== "subscribe") {
      client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Inscrição inválida" }))
      return
    }
    const message: RealtimeClientMessage = parsed.data
    if (message.taskId <= 0 || session.projetoId <= 0) {
      client.send(JSON.stringify({ type: "error", code: "INVALID_SUBSCRIPTION", message: "Tarefa inválida" }))
      return
    }
    const result = this.realtime.inscrever(message.taskId, session.projetoId, client, message.lastSequence)
    if (!result.replayAvailable) {
      client.send(JSON.stringify({ type: "replay_unavailable", taskId: message.taskId, currentSequence: result.currentSequence }))
    }
    client.send(JSON.stringify({ type: "subscribed", taskId: message.taskId, currentSequence: result.currentSequence }))
  }

  @SubscribeMessage("ping")
  ping(@ConnectedSocket() client: WebSocket): void {
    client.send(JSON.stringify({ type: "pong" }))
  }

  private cookie(header: string | undefined, name: string): string | undefined {
    return header?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1)
  }
}
