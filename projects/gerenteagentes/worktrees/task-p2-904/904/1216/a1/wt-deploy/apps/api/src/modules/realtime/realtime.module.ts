import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { RealtimeGateway } from "./realtime.gateway"
import { RealtimeService } from "./realtime.service"
import { RealtimeController } from "./realtime.controller"
import { RealtimeTicketController } from "./realtime-ticket.controller"
import { RealtimeIngressGuard } from "./realtime-ingress.guard"

@Module({ imports: [AuthModule], controllers: [RealtimeController, RealtimeTicketController], providers: [RealtimeService, RealtimeGateway, RealtimeIngressGuard], exports: [RealtimeService] })
export class RealtimeModule {}
