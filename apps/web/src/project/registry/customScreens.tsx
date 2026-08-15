/**
 * registry/customScreens.tsx — telas custom dos projetos (Etapa 9).
 *
 * A config serializável referencia telas custom por `componentId` (string);
 * aqui registramos os componentes no registry da UI (registerCustomScreens).
 * Os componentes vivem nas pastas `projects/<slug>/screens/`; à medida que
 * forem implementados (Etapa 10 — documentação), basta importar e registrar.
 */
import { registerCustomScreens } from "@biblioteca-global/ui"
import DocumentationScreen from "../../../../../projects/documentacao/screens/DocumentationScreen"

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (main.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 */
export function registrarTelasCustom(): void {
  registerCustomScreens({
    documentation: DocumentationScreen,
  })
}
