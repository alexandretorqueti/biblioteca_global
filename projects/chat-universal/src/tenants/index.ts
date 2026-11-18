import { alphaTenant } from "./alpha"
import { isaTenant } from "./isa"
import type { TenantConfig, TenantSlug } from "./types"

export { alphaTenant } from "./alpha"
export { isaTenant } from "./isa"

export const tenants: Record<TenantSlug, TenantConfig> = { isa: isaTenant, alpha: alphaTenant }

export function resolveTenant(hostname: string, queryTenant?: string | null): TenantSlug | undefined {
  if (queryTenant === "isa" || queryTenant === "alpha") return queryTenant
  const host = hostname.toLowerCase().split(":")[0]
  if (host === "isa.globaltecnologia.net" || host === "isa.webconnect.com.br") return "isa"
  if (host === "alpha.globaltecnologia.net" || host === "alpha.webconnect.com.br") return "alpha"
  return undefined
}
