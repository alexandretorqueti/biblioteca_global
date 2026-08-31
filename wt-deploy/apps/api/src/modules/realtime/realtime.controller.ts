import { BadRequestException, Body, Controller, Headers, Inject, Post, UseGuards } from "@nestjs/common"
import { realtimeIngressEventSchema } from "@biblioteca-global/shared"
import { RealtimeIngressGuard } from "./realtime-ingress.guard"
import { RealtimeService } from "./realtime.service"

@Controller("internal/realtime")
@UseGuards(RealtimeIngressGuard)
export class RealtimeController {
  constructor(@Inject(RealtimeService) private readonly realtime: RealtimeService) {}

  @Post("events")
  aceitarEvento(@Body() body: unknown, @Headers("idempotency-key") idempotencyKey?: string) {
    const parsed = realtimeIngressEventSchema.safeParse(body)
    if (!parsed.success) throw new BadRequestException("Evento realtime inválido")
    const eventId = parsed.data.eventId
    if (idempotencyKey && idempotencyKey !== eventId) {
      throw new BadRequestException("Idempotency-Key divergente do eventId")
    }
    if (!this.realtime.aceitarUmaVez(eventId)) {
      return { ok: true, duplicate: true, eventId }
    }
    const evento = this.realtime.publicar(parsed.data)
    return { ok: true, duplicate: false, eventId: evento.eventId, sequence: evento.sequence }
  }
}
