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
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
              { name: "username", label: "Usuário", type: "text", gridVisible: false },
              { name: "email", label: "E-mail", type: "email" },
              { name: "telefone", label: "Telefone", type: "text", gridVisible: false },
              { name: "cpf", label: "CPF", type: "text", gridVisible: false },
              { name: "senhaInicial", label: "Senha inicial", type: "text", minLength: 8, helperText: "Deixe em branco para manter a senha atual", gridVisible: false },
              {
                name: "perfil",
                label: "Perfil",
                type: "select",
                options: [
                  { label: "Administrador", value: "admin" },
                  { label: "Gerente", value: "gerente" },
                  { label: "Operador", value: "operador" },
                  { label: "Visualizador", value: "visualizador" },
                ],
                gridVisible: false,
              },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: false },
            ],
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
            fields: [
              { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
              { name: "slug", label: "Slug", type: "text", required: true, helperText: "Minúsculas, sem espaços (identifica a pasta do projeto)", gridVisible: false },
              {
                name: "config",
                label: "Config (JSON)",
                type: "json",
                fullWidth: true,
                gridVisible: false,
                helperText: "Config serializada do GeradorSistema (validada contra o schema)",
              },
              { name: "ativo", label: "Ativo", type: "switch", defaultValue: true, gridVisible: false },
            ],
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
