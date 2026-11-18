import { Module } from "@nestjs/common"
import { AuthModule } from "../auth/auth.module"
import { BillingModule } from "../billing/billing.module"
import { ProvisionModule } from "../provision/provision.module"
import { PainelTenantController, PainelTenantIngestController } from "./painel-tenant.controller"
import { DrizzleTenantPanelRepository } from "./painel-tenant.repository"
import { PainelTenantRetencaoService } from "./painel-tenant.retencao.service"
import { PainelTenantService } from "./painel-tenant.service"

@Module({ imports: [AuthModule, BillingModule, ProvisionModule], controllers: [PainelTenantController, PainelTenantIngestController], providers: [PainelTenantService, PainelTenantRetencaoService, { provide: "PAINEL_TENANT_REPOSITORY", useClass: DrizzleTenantPanelRepository }, { provide: DrizzleTenantPanelRepository, useExisting: "PAINEL_TENANT_REPOSITORY" }] })
export class PainelTenantModule {}
