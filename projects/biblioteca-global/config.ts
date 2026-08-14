/**
 * Config BASE versionada do projeto biblioteca-global (admin global —
 * PoC §9.1): CRUD de usuários multi-projeto + CRUD de projetos com editor
 * de config. Resources atendidos pelos módulos específicos do core.
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const config: GeradorSistemaConfig = {
  app: { name: "Biblioteca Global", logo: "menu_book" },
  groups: [
    {
      id: "administracao",
      label: "Administração",
      items: [
        {
          id: "usuarios",
          label: "Usuários",
          path: "usuarios",
          icon: "people",
          screen: {
            kind: "cadastro",
            resource: "usuarios",
            title: "Usuários",
            description: "Gerenciamento global de usuários e vínculos",
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columns: 2,
              newLabel: "Novo usuário",
            },
          },
        },
        {
          id: "projetos",
          label: "Projetos",
          path: "projetos",
          icon: "folder",
          screen: {
            kind: "cadastro",
            resource: "projetos",
            title: "Projetos",
            description: "CRUD de projetos com editor de config validado",
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              newLabel: "Novo projeto",
            },
          },
        },
      ],
    },
  ],
}
