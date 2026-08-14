import type {
  EntityRecord,
  GeradorSistemaConfig,
  GeradorSistemaRoute,
} from "../types"

export interface SistemaBreadcrumbItem {
  id: string
  label: string
}

export function findSistemaRoute<T extends EntityRecord>(
  config: GeradorSistemaConfig<T>,
  path: string,
): GeradorSistemaRoute<T> | undefined {
  return config.groups
    .flatMap((group) => group.items)
    .find((item) => item.path === path)
}

export function getSistemaBreadcrumb<T extends EntityRecord>(
  config: GeradorSistemaConfig<T>,
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
