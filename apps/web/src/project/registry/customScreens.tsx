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
interface CustomScreensRegistryModule {
  customScreens?: Record<string, CustomScreenComponent>
}

const registryModules = import.meta.glob<CustomScreensRegistryModule>(
  "../../../../../projects/*/screens/registry.ts",
  { eager: true },
)

/**
 * Agrega registries na ordem dos caminhos, e não na ordem incidental do
 * bundler/filesystem. Assim, o bundle e os testes produzem sempre o mesmo
 * resultado. Em caso de componentId repetido, o caminho lexicalmente maior
 * tem precedência (a mesma semântica de substituição do registry da UI).
 */
export function agregarRegistriesCustom(
  modules: Readonly<Record<string, CustomScreensRegistryModule>>,
): Record<string, CustomScreenComponent> {
  const aggregated: Record<string, CustomScreenComponent> = {}

  for (const path of Object.keys(modules).sort()) {
    const screens = modules[path]?.customScreens
    if (!screens) {
      console.warn(`[registry/customScreens] registry inválido: ${path}`)
      continue
    }
    Object.assign(aggregated, screens)
  }

  return aggregated
}

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (App.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 *
 * Filtra arquivos que não são telas (ex: painéis auxiliares, demos) verificando
 * se exportam `componentId`.
 */
export function registrarTelasCustom(): void {
  registerCustomScreens(agregarRegistriesCustom(registryModules))
}
