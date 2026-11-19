import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { BillingModule } from "../billing/billing.module"
import { EnvModule } from "../../config/env.module"
import { TenantsModule } from "../tenants/tenants.module"
import { CanaisWhatsappBridgeService } from "./canais-whatsapp.bridge"
import { CanaisWhatsappController } from "./canais-whatsapp.controller"
import { CanaisWhatsappReconciler } from "./canais-whatsapp.reconciler"
import { CANAIS_WHATSAPP_REPOSITORY, DrizzleCanaisWhatsappRepository } from "./canais-whatsapp.repository"
import { CanaisWhatsappService } from "./canais-whatsapp.service"
import { CANAIS_WHATSAPP_BRIDGE } from "./canais-whatsapp.types"

@Module({
  imports: [AuthModule, EnvModule, TenantsModule, BillingModule],
  controllers: [CanaisWhatsappController],
  providers: [
    CanaisWhatsappService,
    CanaisWhatsappBridgeService,
    CanaisWhatsappReconciler,
    { provide: CANAIS_WHATSAPP_BRIDGE, useExisting: CanaisWhatsappBridgeService },
    { provide: CANAIS_WHATSAPP_REPOSITORY, useClass: DrizzleCanaisWhatsappRepository },
  ],
  exports: [CanaisWhatsappService],
})
export class CanaisWhatsappModule {}
