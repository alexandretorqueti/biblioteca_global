import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export interface SistemaBreadcrumbItem {
  id: string
  label: string
}

/** Busca a rota pelo path na config SERIALIZÁVEL (nomes mantidos da v1). */
export function findSistemaRoute(
  config: GeradorSistemaConfig,
  path: string,
): GeradorSistemaConfig["groups"][number]["items"][number] | undefined {
  return config.groups
    .flatMap((group) => group.items)
    .find((item) => item.path === path)
}

export function getSistemaBreadcrumb(
  config: GeradorSistemaConfig,
  path: string,
): SistemaBreadcrumbItem[] {
  const group = config.groups.find((candidate) =>
    candidate.items.some((item) => item.path === path),
  )
  const route = group?.items.find((item) => item.path === path)

  if (!group || !route) {
    return []
  }

  return [
    { id: group.id, label: group.label },
    { id: route.id, label: route.label },
  ]
}
