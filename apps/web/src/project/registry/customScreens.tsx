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

import { registerCustomScreens } from "@biblioteca-global/ui"
import type { CustomScreenComponent } from "@biblioteca-global/ui"

/**
 * Autodescoberta de telas custom em build time.
 *
 * Cada projeto é responsável por seu próprio `screens/registry.ts`. O glob
 * importa apenas esses registries e não conhece telas ou slugs concretos.
 */
const registryModules = import.meta.glob<{
  customScreens: Record<string, CustomScreenComponent>
}>("../../../../../projects/*/screens/registry.ts", { eager: true })

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (App.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 *
 * Filtra arquivos que não são telas (ex: painéis auxiliares, demos) verificando
 * se exportam `componentId`.
 */
export function registrarTelasCustom(): void {
  for (const [path, mod] of Object.entries(registryModules)) {
    if (!mod?.customScreens) {
      console.warn(`[registry/customScreens] registry inválido: ${path}`)
      continue
    }
    registerCustomScreens(mod.customScreens)
  }
}
