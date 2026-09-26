/**
 * Registry de telas custom (PoC §7.4): a config serializável referencia
 * telas por `componentId` (string); o registry resolve para o componente.
 * O apps/web registra as telas da pasta projects/<slug>/screens/ (Etapa 9).
 */
import type { ComponentType } from "react"
import type { EntityRecord } from "@biblioteca-global/shared"

/**
 * Contexto injetado pelo GeradorSistema nas telas custom.
 *
 * Em childRoutes (navegação hierárquica), o componente recebe a linha pai
 * clicada (`parentRow`) e o filtro da rota filha (`filterField`/`filterValue`).
 * Em telas custom de menu (nível raiz), as props vêm undefined.
 */
export interface CustomScreenProps {
  /** Linha pai do clique na childRoute (ex.: projeto da grid). */
  parentRow?: EntityRecord
  /** Campo da tabela filha que referencia o pai. */
  filterField?: string
  /** ID do registro pai (valor do filtro). */
  filterValue?: string | number
}

export type CustomScreenComponent = ComponentType<CustomScreenProps>

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
