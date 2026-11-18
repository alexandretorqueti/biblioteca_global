import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import type { TenantPanelRepository } from "./painel-tenant.repository"

@Injectable()
export class PainelTenantRetencaoService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(@Inject("PAINEL_TENANT_REPOSITORY") private readonly repo: TenantPanelRepository) {}
  onModuleInit() { this.timer = setInterval(() => { void this.repo.purge(new Date()) }, 86400000); this.timer.unref?.() }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer) }
  executar(agora = new Date()) { return this.repo.purge(agora) }
}
