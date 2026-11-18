import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { BillingController } from "./billing.controller"
import { BillingWebhookController } from "./billing-webhook.controller"
import { BILLING_REPOSITORY, DrizzleBillingRepository } from "./billing.repository"
import { BillingService } from "./billing.service"
import { MercadoPagoAdapter } from "./mercado-pago.adapter"
import { PSP_BILLING_GATEWAY } from "./psp-billing.gateway"
import { EnvService } from "../../config/env.service"

@Module({
  imports: [AuthModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [
    BillingService,
    {
      provide: MercadoPagoAdapter,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        if (env.pspProvider !== "mercadopago") {
          throw new Error("PSP_PROVIDER deve ser mercadopago para o adaptador configurado")
        }
        return new MercadoPagoAdapter(env)
      },
    },
    { provide: PSP_BILLING_GATEWAY, useExisting: MercadoPagoAdapter },
    { provide: BILLING_REPOSITORY, useClass: DrizzleBillingRepository },
  ],
  exports: [BillingService, PSP_BILLING_GATEWAY],
})
export class BillingModule {}
