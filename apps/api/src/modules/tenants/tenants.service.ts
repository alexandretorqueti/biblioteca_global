import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import {
  normalizeTenantChatConfig,
  type TenantChatConfig,
} from "@biblioteca-global/shared"
import {
  TENANTS_REPOSITORY,
  type TenantRow,
  type TenantsRepository,
} from "./tenants.repository"

export interface ResolveTenantInput {
  host?: string
  slug?: string
}

export function normalizeTenantHost(host: string): string | undefined {
  const value = host.trim().toLowerCase()
  if (!value) return undefined

  let normalized: string
  try {
    normalized = value.includes("://")
      ? new URL(value).hostname
      : new URL(`http://${value}`).hostname
  } catch {
    normalized = value.split("/")[0] ?? value
    if (normalized.startsWith("[")) {
      normalized = normalized.split("]")[0]?.slice(1) ?? normalized
    } else {
      normalized = normalized.split(":")[0] ?? normalized
    }
  }
  return normalized.replace(/\.$/, "") || undefined
}

export interface SuspendedTenantResponse {
  status: "suspenso"
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(TENANTS_REPOSITORY)
    private readonly repository: TenantsRepository,
  ) {}

  async resolveTenant(input: ResolveTenantInput): Promise<TenantRow | undefined> {
    const host = input.host ? normalizeTenantHost(input.host) : undefined
    if (host) {
      const byHost = await this.repository.findByDomain(host)
      if (byHost) return byHost
    }
    const slug = input.slug?.trim()
    return slug ? this.repository.findBySlug(slug) : undefined
  }

  async getChatConfig(
    slug: string,
  ): Promise<TenantChatConfig | SuspendedTenantResponse> {
    const tenant = await this.resolveTenant({ slug })
    if (!tenant) throw new NotFoundException("Tenant não encontrado")
    if (tenant.status === "suspenso") return { status: "suspenso" }
    if (tenant.status !== "ativo") {
      throw new ForbiddenException("Tenant ainda não está ativo")
    }

    const tools = await this.repository.listActiveTools(tenant.id)
    const config = normalizeTenantChatConfig(tenant.configJson, tenant.nome)
    return { ...config, ferramentas: tools.map((tool) => tool.toolKey) }
  }
}
