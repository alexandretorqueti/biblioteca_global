/**
 * registry/customScreens.tsx — telas custom dos projetos (Etapa 9).
 *
 * A config serializável referencia telas custom por `componentId` (string);
 * aqui registramos os componentes no registry da UI (registerCustomScreens).
 * Os componentes vivem nas pastas `projects/<slug>/screens/`; à medida que
 * forem implementados (Etapa 10 — documentação), basta importar e registrar.
 */
import { registerCustomScreens } from "@biblioteca-global/ui"
import type { ReactNode } from "react"

interface PlaceholderScreenProps {
  label: string
}

/** Placeholder enquanto as telas dos projetos não existem (Etapa 10). */
function PlaceholderScreen({
  label,
}: PlaceholderScreenProps): ReactNode {
  const texto = `Tela custom (${label}) — implemente-a na pasta screens do projeto.`
  return <p data-testid="custom-screen-placeholder">{texto}</p>
}

/**
 * Registra as telas custom de todos os projetos. Chamar no boot (main.tsx)
 * uma única vez. Re-registrar substitui a tela anterior pelo componentId.
 */
export function registrarTelasCustom(): void {
  registerCustomScreens({
    documentation: () => <PlaceholderScreen label="documentation" />,
  })
}
