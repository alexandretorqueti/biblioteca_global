import { describe, expect, it } from "vitest"
import type { EntityRecord, GeradorSistemaConfig } from "../../types"
import { findSistemaRoute, getSistemaBreadcrumb } from "../system"

const config: GeradorSistemaConfig<EntityRecord> = {
  app: { name: "Sistema de teste" },
  groups: [
    {
      id: "cadastros",
      label: "Cadastros",
      items: [
        {
          id: "clientes",
          label: "Clientes",
          path: "/clientes",
          screen: { kind: "custom", content: null },
        },
      ],
    },
  ],
}

describe("system utilities", () => {
  it("finds a configured route by its path", () => {
    expect(findSistemaRoute(config, "/clientes")?.label).toBe("Clientes")
    expect(findSistemaRoute(config, "/inexistente")).toBeUndefined()
  })

  it("builds the group and route breadcrumb", () => {
    expect(getSistemaBreadcrumb(config, "/clientes")).toEqual([
      { id: "cadastros", label: "Cadastros" },
      { id: "clientes", label: "Clientes" },
    ])
    expect(getSistemaBreadcrumb(config, "/inexistente")).toEqual([])
  })
})
