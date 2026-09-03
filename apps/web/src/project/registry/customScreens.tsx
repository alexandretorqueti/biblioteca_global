/**
 * registry/customScreens.tsx — autodescoberta de telas custom dos projetos.
 *
 * Autodescoberta em build time via `import.meta.glob` do Vite: varre todos
 * os arquivos `.tsx` em `projects/<slug>/screens/` e registra cada tela pelo
 * `componentId` exportado. Cada tela deve exportar:
 *
 *   export const componentId = "slug-nome-tela"
 *   export default function TelaCustom() { ... }
 *
 * Novas telas custom funcionam apenas por existir em `projects/<slug>/screens/`
 * com `componentId` exportado — sem edição manual deste arquivo.
 */

import type { ComponentType } from "react"
import { registerCustomScreens } from "@biblioteca-global/ui"

/**
 * Autodescoberta de telas custom em build time.
 *
 * `import.meta.glob` com `eager: true` importa todos os módulos no bundle
 * final (sem fetch runtime). O Vite resolve os paths em tempo de build.
 * Cada módulo deve exportar `componentId` (string) e `default` (componente).
 */
const screenModules = import.meta.glob<{
  componentId: string
  default: ComponentType
}>("../../../../../projects/*/screens/*.tsx", { eager: true })

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (App.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 *
 * Filtra arquivos que não são telas (ex: painéis auxiliares, demos) verificando
 * se exportam `componentId`.
 */
export function registrarTelasCustom(): void {
  const screens: Record<string, ComponentType> = {}

  for (const mod of Object.values(screenModules)) {
    if (!mod?.componentId || !mod?.default) {
      // Arquivo sem componentId ou sem default export — não é uma tela registrável
      continue
    }
    screens[mod.componentId] = mod.default
  }

  if (Object.keys(screens).length > 0) {
    registerCustomScreens(screens)
  }
}
