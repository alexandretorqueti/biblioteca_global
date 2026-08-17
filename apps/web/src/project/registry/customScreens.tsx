/**
 * registry/customScreens.tsx — registro das telas custom dos projetos.
 *
 * Atualmente o único projeto que possui tela custom é "documentacao". A
 * implementação anterior registrava um placeholder genérico e, em seguida,
 * uma chave separada `docScreen`. O manual (§38) especifica que a configuração
 * do projeto referencia o componentId **"documentation"**; portanto devemos
 * registrar exatamente esse id com a tela real.
 */

import { registerCustomScreens } from "@biblioteca-global/ui"
import DocumentationScreen from "../../../../../projects/documentacao/screens/DocumentationScreen"
import DashboardScreen from "../../../../../projects/gerenteagentes/screens/DashboardScreen"

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (main.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 */
export function registrarTelasCustom(): void {
  registerCustomScreens({
    documentation: DocumentationScreen,
    "gerenteagentes-dashboard": DashboardScreen,
  })
}
