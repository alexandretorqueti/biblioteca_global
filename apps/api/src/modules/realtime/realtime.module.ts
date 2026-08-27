import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { RealtimeGateway } from "./realtime.gateway"
import { RealtimeService } from "./realtime.service"

@Module({ imports: [AuthModule], providers: [RealtimeService, RealtimeGateway], exports: [RealtimeService] })
export class RealtimeModule {}
