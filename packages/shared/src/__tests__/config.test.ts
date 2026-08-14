import { describe, expect, it } from "vitest"
import {
  cadastroScreenConfigSchema,
  geradorSistemaConfigSchema,
  loginRequestSchema,
  screenConfigSchema,
} from "../index"
import type { GeradorSistemaConfig } from "../index"

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

  it("rejeita grupos vazios", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      app: { name: "X" },
      groups: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejeita chave desconhecida (strict)", () => {
    const result = geradorSistemaConfigSchema.safeParse({
      ...configValida,
      chaveSurpresa: true,
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
