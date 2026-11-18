import { Module } from "@nestjs/common"
import { VendasController } from "./vendas.controller"
import { VendasService } from "./vendas.service"
import { DrizzleVendasRepository, VENDAS_REPOSITORY } from "./vendas.repository"
import { BillingModule } from "../billing/billing.module"
import { AuthModule } from "../auth/auth.module"
import { ForjadorModule } from "../forjador/forjador.module"
import { DrizzleProvisionamentoRepository, PROVISIONAMENTO_REPOSITORY } from "./provisionamento.repository"
import { ProvisionamentoWorker } from "./provisionamento.worker"

@Module({
  imports: [BillingModule, AuthModule, ForjadorModule],
  controllers: [VendasController],
  providers: [
    VendasService,
    { provide: VENDAS_REPOSITORY, useClass: DrizzleVendasRepository },
    ProvisionamentoWorker,
    { provide: PROVISIONAMENTO_REPOSITORY, useClass: DrizzleProvisionamentoRepository },
  ],
  exports: [VendasService],
})
export class VendasModule {}
