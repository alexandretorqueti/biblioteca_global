/**
 * RealtimeTicketController — emite ticket temporário para handshake WebSocket.
 *
 * Cross-origin (front em domínio diferente da API) impede envio de cookie
 * HttpOnly no handshake WebSocket. A solução padrão da indústria (Slack,
 * Discord, GitHub Live) é emitir um ticket de curta duração via HTTP
 * autenticado e usá-lo como query parameter no WebSocket.
 *
 * O ticket é um JWT de 30s com claim `kind: "ws-ticket"` — não tem `perfil`,
 * então o JwtAuthGuard das rotas HTTP rejeita automaticamente (evita que
 * ticket interceptado seja usado como Bearer em outras rotas).
 */
import { Controller, Get, Inject, Request, UseGuards } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import type { ApiRequest } from "../../common/types"

@Controller("realtime")
export class RealtimeTicketController {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  @Get("ticket")
  @UseGuards(JwtAuthGuard)
  async gerarTicket(@Request() req: ApiRequest): Promise<{ ticket: string }> {
    const claims = req.authClaims
    if (!claims) throw new Error("claims ausentes")
    const ticket = await this.jwt.signAsync(
      { sub: claims.sub, projetoId: claims.projetoId, kind: "ws-ticket" },
      { expiresIn: "30s" },
    )
    return { ticket }
  }
}
