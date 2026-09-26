/**
 * Config BASE versionada do projeto documentacao (PoC §7.4): menu/UX por
 * padrão, usada no provisionamento. A config CORRENTE vive no core
 * (iniciada igual à base + telas geradas do schema).
 * A tela Usuários é injetada automaticamente pela plataforma (PoC §8).
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Documentação", logo: "menu_book" },
  groups: [
    {
      id: "documentacao",
      label: "Documentação",
      items: [
        {
          id: "documentacao",
          label: "Biblioteca de Componentes",
          path: "documentacao",
          icon: "menu_book",
          screen: { kind: "custom", componentId: "documentation" },
        },
      ],
    },
  ],
}
