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
// Tela real do projeto "documentacao" (Etapa 10).
// Caminho correto para a tela de documentação dentro do monorepo.
import DocumentationScreen from "../../../../../projects/documentacao/screens/DocScreen"

/** Registra as telas custom. Atualmente apenas a documentação. */
export function registrarTelasCustom(): void {
  registerCustomScreens({
    documentation: DocumentationScreen,
  })
}
