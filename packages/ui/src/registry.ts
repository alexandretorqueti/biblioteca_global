/**
 * Registry de telas custom (PoC §7.4): a config serializável referencia
 * telas por `componentId` (string); o registry resolve para o componente.
 * O apps/web registra as telas da pasta projects/<slug>/screens/ (Etapa 9).
 */
import type { ComponentType, ReactNode } from "react"

export type CustomScreenComponent =
  | ComponentType
  | (() => ReactNode)

const customScreens = new Map<string, CustomScreenComponent>()

/** Registra (ou substitui) uma tela custom pelo componentId. */
export function registerCustomScreens(
  screens: Record<string, CustomScreenComponent>,
): void {
  for (const [componentId, component] of Object.entries(screens)) {
    customScreens.set(componentId, component)
  }
}

/** Retorna a tela custom registrada, ou undefined se não existir. */
export function getCustomScreen(
  componentId: string,
): CustomScreenComponent | undefined {
  return customScreens.get(componentId)
}

/** Limpa o registry (testes). */
export function clearCustomScreens(): void {
  customScreens.clear()
}
