import { describe, expect, it } from "vitest"
import {
  cadastroScreenConfigSchema,
  childScreenSchema,
  customActionSchema,
  dynamicFieldConfigSchema,
  externalScreenConfigSchema,
  geradorSistemaConfigSchema,
  loginRequestSchema,
  relatedScreenSchema,
  screenConfigSchema,
} from "../index.js"
import type {
  EditScreenConfig,
  ExternalScreenConfig,
  GeradorSistemaConfig,
} from "../index.js"

/** Config válida no formato do projeto biblioteca-global (PoC §7.3/§9.1). */
const configValida: GeradorSistemaConfig = {
  app: { name: "Biblioteca Global", logo: "menu_book" },
  drawerWidth: 280,
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
            description: "Usuários do projeto",
            overrides: {
              hiddenColumns: ["createdAt", "updatedAt"],
              columns: 2,
              newLabel: "Novo usuário",
            },
          },
        },
        {
          id: "documentacao",
          label: "Documentação",
          path: "documentacao",
          icon: "menu_book",
          screen: { kind: "custom", componentId: "documentation" },
        },
      ],
    },
  ],
}

describe("geradorSistemaConfigSchema", () => {
  it("aceita config válida (cadastro com overrides + custom)", () => {
    const result = geradorSistemaConfigSchema.safeParse(configValida)
    expect(result.success).toBe(true)
  })

  it("aceita config mínima (app + 1 grupo + 1 item)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Mínimo" },
      groups: [
        {
          id: "g",
          label: "G",
          items: [
            {
              id: "i",
              label: "I",
              path: "i",
              screen: { kind: "custom", componentId: "x" },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("rejeita campo obrigatório ausente (app.name)", () => {
    const semApp: Record<string, unknown> = { ...configValida }
    delete semApp.app
    const result = geradorSistemaConfigSchema.safeParse(semApp)
    expect(result.success).toBe(false)
  })

  it("rejeita campo obrigatório ausente (item.screen)", () => {
    const grupo = configValida.groups.at(0)
    if (!grupo) {
      throw new Error("config de teste deveria ter pelo menos 1 grupo")
    }
    const semScreen = {
      ...configValida,
      groups: [
        {
          id: grupo.id,
          label: grupo.label,
          items: [{ id: "i", label: "I", path: "i" }],
        },
      ],
    }
    const result = geradorSistemaConfigSchema.safeParse(semScreen)
    expect(result.success).toBe(false)
  })

  it("rejeita estrutura inválida (kind de tela desconhecido)", () => {
    const result = screenConfigSchema.safeParse({
      kind: "relatorio",
      resource: "x",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita cadastro sem resource", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      title: "Sem resource",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita resource com nome inválido (não é snake_case minúsculo)", () => {
    for (const resource of ["Usuarios", "1_tabela", "minha-tabela", ""]) {
      const result = cadastroScreenConfigSchema.safeParse({
        kind: "cadastro",
        resource,
      })
      expect(result.success, `resource "${resource}" deveria falhar`).toBe(
        false,
      )
    }
  })

  it("rejeita custom sem componentId", () => {
    const result = screenConfigSchema.safeParse({ kind: "custom" })
    expect(result.success).toBe(false)
  })

  it("rejeita columns fora de 1|2|3", () => {
    const configComColumnsInvalida = {
      app: { name: "Biblioteca Global" },
      groups: [
        {
          id: "administracao",
          label: "Administração",
          items: [
            {
              id: "usuarios",
              label: "Usuários",
              path: "usuarios",
              screen: {
                kind: "cadastro",
                resource: "usuarios",
                overrides: { columns: 5 },
              },
            },
          ],
        },
      ],
    }
    const result = geradorSistemaConfigSchema.safeParse(configComColumnsInvalida)
    expect(result.success).toBe(false)
  })

  it("aceita grupos vazios (projeto novo nasce sem telas; Usuários é injetada pela plataforma)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "X" },
      groups: [],
    })
    expect(result.success).toBe(true)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      ...configValida,
      chaveSurpresa: true,
    })
    expect(result.success).toBe(false)
  })
})

describe("dynamicFieldConfigSchema", () => {
  it("aceita flags de contexto (insertable/editable/gridVisible) e tipo json", () => {
    const result = dynamicFieldConfigSchema.safeParse({
      name: "config",
      label: "Config (JSON)",
      type: "json",
      insertable: true,
      editable: true,
      gridVisible: false,
    })
    expect(result.success).toBe(true)
  })

  it("aceita campo sem as flags (default: aparece em todos os contextos)", () => {
    const result = dynamicFieldConfigSchema.safeParse({
      name: "nome",
      label: "Nome",
      type: "text",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita flag desconhecida (strict)", () => {
    const result = dynamicFieldConfigSchema.safeParse({
      name: "nome",
      label: "Nome",
      type: "text",
      visivelNoBanco: true,
    })
    expect(result.success).toBe(false)
  })
})

describe("loginRequestSchema", () => {
  it("aceita login válido com identifierType", () => {
    const result = loginRequestSchema.safeParse({
      identifier: "alexandre",
      password: "senha-secreta",
      identifierType: "username",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita identifierType fora do enum", () => {
    const result = loginRequestSchema.safeParse({
      identifier: "alexandre",
      password: "senha-secreta",
      identifierType: "pix",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita payload vazio", () => {
    const result = loginRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe("relatedScreenSchema", () => {
  it("aceita relatedScreens válido", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "usuarios",
      relatedScreens: [
        { childResource: "pedidos", label: "Pedidos" },
        { childResource: "pagamentos", label: "Pagamentos" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita cadastro sem relatedScreens (opcional)", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "usuarios",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita childResource fora da whitelist (não é snake_case minúsculo)", () => {
    for (const childResource of [
      "Pedidos",
      "1_pedido",
      "meus-pedidos",
      "",
    ]) {
      const result = relatedScreenSchema.safeParse({
        childResource,
        label: "Teste",
      })
      expect(
        result.success,
        `childResource "${childResource}" deveria falhar`,
      ).toBe(false)
    }
  })

  it("rejeita sem childResource", () => {
    const result = relatedScreenSchema.safeParse({ label: "Teste" })
    expect(result.success).toBe(false)
  })

  it("rejeita sem label", () => {
    const result = relatedScreenSchema.safeParse({ childResource: "x" })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = relatedScreenSchema.safeParse({
      childResource: "x",
      label: "Teste",
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it("aceita relatedScreens em config completa", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "clientes",
              label: "Clientes",
              path: "clientes",
              icon: "people",
              screen: {
                kind: "cadastro",
                resource: "clientes",
                title: "Clientes",
                relatedScreens: [{ childResource: "pedidos", label: "Pedidos" }],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("childScreenSchema", () => {
  it("aceita child válido com fkField obrigatório", () => {
    const result = childScreenSchema.safeParse({
      childResource: "pedidos",
      fkField: "clienteId",
      label: "Pedidos",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita sem fkField (obrigatório)", () => {
    const result = childScreenSchema.safeParse({
      childResource: "pedidos",
      label: "Pedidos",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita fkField vazio", () => {
    const result = childScreenSchema.safeParse({
      childResource: "pedidos",
      fkField: "",
      label: "Pedidos",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita childResource fora da whitelist", () => {
    for (const childResource of [
      "Pedidos",
      "1_pedido",
      "meus-pedidos",
      "",
    ]) {
      const result = childScreenSchema.safeParse({
        childResource,
        fkField: "clienteId",
        label: "Teste",
      })
      expect(
        result.success,
        `childResource "${childResource}" deveria falhar`,
      ).toBe(false)
    }
  })

  it("rejeita sem label", () => {
    const result = childScreenSchema.safeParse({
      childResource: "pedidos",
      fkField: "clienteId",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = childScreenSchema.safeParse({
      childResource: "pedidos",
      fkField: "clienteId",
      label: "Pedidos",
      extra: true,
    })
    expect(result.success).toBe(false)
  })
})

describe("children em cadastroScreenConfigSchema", () => {
  it("aceita children com fkField", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "clientes",
      children: [
        { childResource: "pedidos", fkField: "clienteId", label: "Pedidos" },
        { childResource: "pagamentos", fkField: "pedidoId", label: "Pagamentos" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita cadastro sem children (opcional)", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "clientes",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita children com childResource inválido", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "clientes",
      children: [{ childResource: "Pedidos", fkField: "clienteId", label: "X" }],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita children com fkField vazio", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "clientes",
      children: [{ childResource: "pedidos", fkField: "", label: "X" }],
    })
    expect(result.success).toBe(false)
  })

  it("aceita children em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "agentes",
              label: "Agentes",
              path: "agentes",
              icon: "smart_toy",
              screen: {
                kind: "cadastro",
                resource: "agentes",
                title: "Agentes",
                children: [
                  { childResource: "tarefas", fkField: "agenteId", label: "Tarefas" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("externalScreenConfigSchema", () => {
  it("aceita external com baseUrl, method e pathTemplate válidos", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("aceita outros métodos HTTP válidos", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const result = externalScreenConfigSchema.safeParse({
        kind: "external",
        baseUrl: "https://api.exemplo.com",
        method,
        pathTemplate: "/task/:id",
      })
      expect(result.success).toBe(true)
    }
  })

  it("aceita pathTemplate com múltiplos placeholders", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/projeto/:projetoId/agente/:agenteId/tarefa/:tarefaId",
    })
    expect(result.success).toBe(true)
  })

  it("aceita pathTemplate sem placeholders", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/health",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita baseUrl inválida (não é URL)", () => {
    for (const baseUrl of [
      "not-a-url",
      "http://",       // host faltando
      "",              // vazio
    ]) {
      const result = externalScreenConfigSchema.safeParse({
        kind: "external",
        baseUrl,
        method: "GET",
        pathTemplate: "/task/:id",
      })
      expect(
        result.success,
        `baseUrl "${baseUrl}" deveria falhar`,
      ).toBe(false)
    }
  })

  it("rejeita method HTTP inválido", () => {
    for (const method of ["OPTIONS", "HEAD", "get", "invalid"] as const) {
      const result = externalScreenConfigSchema.safeParse({
        kind: "external",
        baseUrl: "https://api.exemplo.com",
        method,
        pathTemplate: "/task/:id",
      })
      expect(
        result.success,
        `method "${method}" deveria falhar`,
      ).toBe(false)
    }
  })

  it("rejeita pathTemplate vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita kind diferente de external", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "cadastro",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it("rejeita sem baseUrl", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      method: "GET",
      pathTemplate: "/task/:id",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita sem method", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      pathTemplate: "/task/:id",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita sem pathTemplate", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("aceita external como kind na screenConfigSchema (discriminatedUnion)", () => {
    const result = screenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("aceita external em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "tarefas-externas",
              label: "Tarefas Externas",
              path: "tarefas-externas",
              icon: "link",
              screen: {
                kind: "external",
                baseUrl: "https://api.agente-interno.local",
                method: "GET",
                pathTemplate: "/api/task/:id",
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("actions em externalScreenConfigSchema", () => {
  it("aceita external com actions válidas", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "executar", label: "Executar", method: "POST", path: "/task/:id/executar" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external sem actions (opcional)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita action com path vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "POST", path: "" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita action com method inválido", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "OPTIONS" as any, path: "/test" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida em action (strict)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "POST", path: "/test", extra: true },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("aceita external com confirm em action", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "DELETE",
      pathTemplate: "/task/:id",
      actions: [
        { id: "deletar", label: "Deletar", method: "DELETE", path: "/task/:id", confirm: "Confirmar exclusão?" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita multiple actions com confirmações diferentes", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "aprovar", label: "Aprovar", method: "POST", path: "/task/:id/aprovar", confirm: "Aprovar tarefa?" },
        { id: "rejeitar", label: "Rejeitar", method: "POST", path: "/task/:id/rejeitar", confirm: "Rejeitar tarefa?" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external com actions em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "tarefas-externas",
              label: "Tarefas Externas",
              path: "tarefas-externas",
              icon: "link",
              screen: {
                kind: "external",
                baseUrl: "https://api.agente-interno.local",
                method: "GET",
                pathTemplate: "/api/task/:id",
                actions: [
                  { id: "executar", label: "Executar", method: "POST", path: "/api/task/:id/executar" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external como kind na screenConfigSchema com actions", () => {
    const result = screenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "executar", label: "Executar", method: "POST", path: "/task/:id/executar" },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("customActionSchema", () => {
  it("aceita action com method e path obrigatórios", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "Aprovar",
      method: "POST",
      path: "/agente/:id/aprovar",
    })
    expect(result.success).toBe(true)
  })

  it("aceita action com confirm opcional", () => {
    const result = customActionSchema.safeParse({
      id: "desativar",
      label: "Desativar Agente",
      method: "DELETE",
      path: "/agente/:id",
      confirm: "Tem certeza que deseja desativar este agente?",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita sem id", () => {
    const result = customActionSchema.safeParse({
      label: "Aprovar",
      method: "POST",
      path: "/agente/:id/aprovar",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita id vazio", () => {
    const result = customActionSchema.safeParse({
      id: "",
      label: "Aprovar",
      method: "POST",
      path: "/agente/:id/aprovar",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita sem label", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      method: "POST",
      path: "/agente/:id/aprovar",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita label vazio", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "",
      method: "POST",
      path: "/agente/:id/aprovar",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita method inválido", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "Aprovar",
      method: "OPTIONS" as any,
      path: "/agente/:id/aprovar",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita sem path", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "Aprovar",
      method: "POST",
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita path vazio", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "Aprovar",
      method: "POST",
      path: "",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = customActionSchema.safeParse({
      id: "aprovar",
      label: "Aprovar",
      method: "POST",
      path: "/agente/:id/aprovar",
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  it("aceita todos os methods HTTP válidos", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const result = customActionSchema.safeParse({
        id: "x",
        label: "X",
        method,
        path: "/test",
      })
      expect(result.success).toBe(true)
    }
  })

  it("aceita path com múltiplos placeholders", () => {
    const result = customActionSchema.safeParse({
      id: "executar",
      label: "Executar Tarefa",
      method: "POST",
      path: "/projeto/:projetoId/agente/:agenteId/tarefa/:tarefaId/executar",
    })
    expect(result.success).toBe(true)
  })
})

describe("actions em cadastroScreenConfigSchema", () => {
  it("aceita cadastro com actions válidas", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "agentes",
      title: "Agentes",
      actions: [
        { id: "aprovar", label: "Aprovar", method: "POST", path: "/agente/:id/aprovar" },
        { id: "desativar", label: "Desativar", method: "DELETE", path: "/agente/:id", confirm: "Tem certeza?" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita cadastro sem actions (opcional)", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "usuarios",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita action com method inválido", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "agentes",
      actions: [
        { id: "x", label: "X", method: "OPTIONS" as any, path: "/test" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita action com path vazio", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "agentes",
      actions: [
        { id: "x", label: "X", method: "POST", path: "" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida em action (strict)", () => {
    const result = cadastroScreenConfigSchema.safeParse({
      kind: "cadastro",
      resource: "agentes",
      actions: [
        { id: "x", label: "X", method: "POST", path: "/test", extra: true },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("aceita actions em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "agentes",
              label: "Agentes",
              path: "agentes",
              icon: "smart_toy",
              screen: {
                kind: "cadastro",
                resource: "agentes",
                title: "Agentes",
                actions: [
                  { id: "aprovar", label: "Aprovar", method: "POST", path: "/agente/:id/aprovar" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("hiddenColumns em externalScreenConfigSchema (st-1)", () => {
  it("aceita hiddenColumns vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      hiddenColumns: [],
    })
    expect(result.success).toBe(true)
  })

  it("aceita hiddenColumns com nomes de campo", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      hiddenColumns: ["createdAt", "updatedAt", "deletedAt"],
    })
    expect(result.success).toBe(true)
  })

  it("rejeita hiddenColumns com nome vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      hiddenColumns: ["createdAt", ""],
    })
    expect(result.success).toBe(false)
  })

  it("hiddenColumns é opcional (comportamento preservado)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("hiddenColumns aceitado em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Teste" },
      groups: [
        {
          id: "g",
          label: "G",
          items: [
            {
              id: "i",
              label: "I",
              path: "i",
              icon: "link",
              screen: {
                kind: "external",
                baseUrl: "https://api.exemplo.com",
                method: "GET",
                pathTemplate: "/task/:id",
                hiddenColumns: ["secretField"],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("edit em externalScreenConfigSchema (st-1)", () => {
  it("aceita edit com method e pathTemplate obrigatórios", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PATCH",
        pathTemplate: "/task/:id",
      },
    })
    expect(result.success).toBe(true)
  })

  it("aceita todos os methods HTTP válidos em edit", () => {
    for (const method of ["PUT", "PATCH", "POST"] as const) {
      const result = externalScreenConfigSchema.safeParse({
        kind: "external",
        baseUrl: "https://api.exemplo.com",
        method: "GET",
        pathTemplate: "/task/:id",
        edit: { method, pathTemplate: "/task/:id" },
      })
      expect(result.success).toBe(true)
    }
  })

  it("rejeita edit sem pathTemplate", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: { method: "PATCH" },
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita edit com method inválido", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: { method: "OPTIONS" as any, pathTemplate: "/task/:id" },
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("rejeita edit com pathTemplate vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: { method: "PATCH", pathTemplate: "" },
    })
    expect(result.success).toBe(false)
  })

  it("edit com fields válidos", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PUT",
        pathTemplate: "/task/:id",
        fields: [
          { name: "nome", label: "Nome", type: "text" },
          { name: "status", label: "Status", type: "multipleChoice", multipleChoiceOptions: [{ value: "ativo", label: "Ativo" }] },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it("rejeita edit com field sem name", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PUT",
        pathTemplate: "/task/:id",
        fields: [{ label: "Sem name" }],
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejeita edit com field com name vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PUT",
        pathTemplate: "/task/:id",
        fields: [{ name: "", label: "Nome vazio" }],
      },
    })
    expect(result.success).toBe(false)
  })

  it("edit aceita bodyPath opcional", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PUT",
        pathTemplate: "/task/:id",
        bodyPath: "result",
      },
    })
    expect(result.success).toBe(true)
  })

  it("edit aceita fields com flags de contexto", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: {
        method: "PATCH",
        pathTemplate: "/task/:id",
        fields: [
          { name: "nome", editable: false, gridVisible: false },
          { name: "status", insertable: true, editable: true },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it("edit é opcional (comportamento preservado)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("edit rejeita chave desconhecida (strict)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      edit: { method: "PATCH", pathTemplate: "/task/:id", extra: true },
    } as unknown)
    expect(result.success).toBe(false)
  })

  it("edit aceitado em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Teste" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "tarefas-edit",
              label: "Tarefas Editáveis",
              path: "tarefas-edit",
              icon: "edit",
              screen: {
                kind: "external",
                baseUrl: "https://motor.local",
                method: "GET",
                pathTemplate: "/api/task/:id",
                edit: {
                  method: "PATCH",
                  pathTemplate: "/api/task/:id",
                  fields: [
                    { name: "status", label: "Status" },
                    { name: "observacao", label: "Observação" },
                  ],
                },
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("EditScreenConfig é exportado como tipo", () => {
    // Testa que o tipo existe e é inferível sem erro de compilação.
    const cfg: EditScreenConfig = {
      method: "PATCH",
      pathTemplate: "/task/:id",
      fields: [{ name: "status" }],
    }
    expect(cfg.method).toBe("PATCH")
    expect(cfg.pathTemplate).toBe("/task/:id")
    expect(cfg.fields).toHaveLength(1)
  })
})

describe("actions em externalScreenConfigSchema", () => {
  it("aceita external com actions válidas", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "executar", label: "Executar", method: "POST", path: "/task/:id/executar" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external sem actions (opcional)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita action com path vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "POST", path: "" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita action com method inválido", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "OPTIONS" as any, path: "/test" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida em action (strict)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "x", label: "X", method: "POST", path: "/test", extra: true },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("aceita external com confirm em action", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "DELETE",
      pathTemplate: "/task/:id",
      actions: [
        { id: "deletar", label: "Deletar", method: "DELETE", path: "/task/:id", confirm: "Confirmar exclusão?" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita multiple actions com confirmações diferentes", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "aprovar", label: "Aprovar", method: "POST", path: "/task/:id/aprovar", confirm: "Aprovar tarefa?" },
        { id: "rejeitar", label: "Rejeitar", method: "POST", path: "/task/:id/rejeitar", confirm: "Rejeitar tarefa?" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external com actions em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente de Agentes" },
      groups: [
        {
          id: "negocios",
          label: "Negócios",
          items: [
            {
              id: "tarefas-externas",
              label: "Tarefas Externas",
              path: "tarefas-externas",
              icon: "link",
              screen: {
                kind: "external",
                baseUrl: "https://api.agente-interno.local",
                method: "GET",
                pathTemplate: "/api/task/:id",
                actions: [
                  { id: "executar", label: "Executar", method: "POST", path: "/api/task/:id/executar" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("aceita external como kind na screenConfigSchema com actions", () => {
    const result = screenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      actions: [
        { id: "executar", label: "Executar", method: "POST", path: "/task/:id/executar" },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("dataPath em externalScreenConfigSchema", () => {
  it("aceita dataPath com caminho simples (ex.: 'projects')", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      dataPath: "projects",
    })
    expect(result.success).toBe(true)
  })

  it("aceita external sem dataPath (contrato existente preservado)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita dataPath vazio", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      dataPath: "",
    })
    expect(result.success).toBe(false)
  })

  it("aceita dataPath com caminho em cascata (ex.: 'items.data')", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      dataPath: "items.data",
    })
    expect(result.success).toBe(true)
  })

  it("dataPath aceitado na screenConfigSchema (discriminatedUnion)", () => {
    const result = screenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      dataPath: "projects",
    })
    expect(result.success).toBe(true)
  })

  it("dataPath aceitado em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Dashboard" },
      groups: [
        {
          id: "projeto-1",
          label: "Projeto 1",
          items: [
            {
              id: "tarefas",
              label: "Tarefas",
              path: "tarefas",
              icon: "folder",
              screen: {
                kind: "external",
                baseUrl: "https://motor.global.local",
                method: "GET",
                pathTemplate: "/api/projects/:projetoId/tarefas",
                dataPath: "tarefas",
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("rejeita chave desconhecida junto com dataPath (strict)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      dataPath: "projects",
      extraField: true,
    })
    expect(result.success).toBe(false)
  })
})

describe("chat em externalScreenConfigSchema (st-7)", () => {
  it("aceita chat:true", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://motor.local",
      method: "GET",
      pathTemplate: "/task/:id",
      chat: true,
    })
    expect(result.success).toBe(true)
  })

  it("aceita chat:false", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://motor.local",
      method: "GET",
      pathTemplate: "/task/:id",
      chat: false,
    })
    expect(result.success).toBe(true)
  })

  it("aceita external sem chat (opcional, preservado)", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://motor.local",
      method: "GET",
      pathTemplate: "/task/:id",
    })
    expect(result.success).toBe(true)
  })

  it("chat aceitado em config completa (geradorSistemaConfigSchema)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Dashboard" },
      groups: [
        {
          id: "projeto-1",
          label: "Projeto 1",
          items: [
            {
              id: "tarefas",
              label: "Tarefas",
              path: "tarefas",
              icon: "chat",
              screen: {
                kind: "external",
                baseUrl: "https://motor.global.local",
                method: "GET",
                pathTemplate: "/api/task/:id",
                detailPathTemplate: "/api/task/:id/detail",
                chat: true,
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("chat aceitado na screenConfigSchema (discriminatedUnion)", () => {
    const result = screenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "https://api.exemplo.com",
      method: "GET",
      pathTemplate: "/task/:id",
      chat: true,
    })
    expect(result.success).toBe(true)
  })
})

describe("tela Tarefas externa do gerenteagentes (st-9)", () => {
  it("config de tarefas externas valida (dataPath, detail, actions)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente Agentes" },
      groups: [
        {
          id: "dashboard",
          label: "Dashboard",
          items: [
            {
              id: "tarefas-dashboard",
              label: "Tarefas",
              path: "tarefas",
              icon: "assignment_turned_in",
              screen: {
                kind: "external",
                baseUrl: "http://motor.local",
                method: "GET",
                pathTemplate: "/api/projects/:agentId/tasks",
                dataPath: "tasks",
                detailPathTemplate: "/task/:id",
                detailDataPath: "task",
                chat: true,
                actions: [
                  {
                    id: "start-task",
                    label: "Iniciar",
                    method: "POST",
                    path: "/task/:id/start",
                  },
                  {
                    id: "pause-task",
                    label: "Pausar",
                    method: "POST",
                    path: "/task/:id/pause",
                  },
                  {
                    id: "resume-task",
                    label: "Retomar",
                    method: "POST",
                    path: "/task/:id/resume",
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("detailPathTemplate + detailDataPath em externalScreenConfigSchema", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "http://motor.local",
      method: "GET",
      pathTemplate: "/api/projects/:agentId/tasks",
      dataPath: "tasks",
      detailPathTemplate: "/task/:id",
      detailDataPath: "task",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita action sem path (customActionSchema)", () => {
    const result = customActionSchema.safeParse({
      id: "test",
      label: "Test",
      method: "POST",
      path: "",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita action com method inválido", () => {
    const result = customActionSchema.safeParse({
      id: "test",
      label: "Test",
      method: "OPTIONS",
      path: "/task/:id/start",
    })
    expect(result.success).toBe(false)
  })

  it("config gerenteagentes com tela Tarefas externa + ações start/pause/resume", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente Agentes" },
      groups: [
        {
          id: "dashboard",
          label: "Dashboard",
          items: [
            {
              id: "tarefas-dashboard",
              label: "Tarefas",
              path: "tarefas",
              icon: "assignment_turned_in",
              screen: {
                kind: "external",
                baseUrl: "http://192.168.1.16:6283",
                method: "GET",
                pathTemplate: "/api/projects/:agentId/tasks",
                dataPath: "tasks",
                detailPathTemplate: "/task/:id",
                detailDataPath: "task",
                chat: true,
                actions: [
                  { id: "start-task", label: "Iniciar", method: "POST", path: "/task/:id/start" },
                  { id: "pause-task", label: "Pausar", method: "POST", path: "/task/:id/pause" },
                  { id: "resume-task", label: "Retomar", method: "POST", path: "/task/:id/resume" },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("externalScreenConfigSchema rejeita chave extra com detailPathTemplate", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "http://motor.local",
      method: "GET",
      pathTemplate: "/api/projects/:agentId/tasks",
      dataPath: "tasks",
      detailPathTemplate: "/task/:id",
      extraField: true,
    })
    expect(result.success).toBe(false)
  })

  it("externalScreenConfigSchema aceita query como record de filtros", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "http://motor.local",
      method: "GET",
      pathTemplate: "/api/contatos",
      dataPath: "contatos",
      query: {
        filtro: "todos",
      },
    })
    expect(result.success).toBe(true)
  })

  it("externalScreenConfigSchema aceita query com valores numéricos e booleanos", () => {
    const result = externalScreenConfigSchema.safeParse({
      kind: "external",
      baseUrl: "http://motor.local",
      method: "GET",
      pathTemplate: "/api/contatos",
      dataPath: "contatos",
      query: {
        pagina: 1,
        ativo: true,
        limite: 50,
      },
    })
    expect(result.success).toBe(true)
  })

  it("config gerenteagentes validado completo com Definicoes e Contatos", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "Gerente Agentes" },
      groups: [
        {
          id: "definicoes",
          label: "Definições e Contatos",
          items: [
            {
              id: "definicoes-list",
              label: "Definições",
              path: "definicoes",
              icon: "category",
              screen: {
                kind: "external",
                baseUrl: "http://motor.local",
                method: "GET",
                pathTemplate: "/api/projects/:slug/definitions",
                dataPath: "definitions",
              },
            },
            {
              id: "contatos-list",
              label: "Contatos",
              path: "contatos",
              icon: "contacts",
              screen: {
                kind: "external",
                baseUrl: "http://motor.local",
                method: "GET",
                pathTemplate: "/api/contatos",
                dataPath: "contatos",
                query: {
                  filtro: "todos",
                },
              },
            },
          ],
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})
