import { describe, expect, it } from "vitest"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import { findSistemaRoute, getSistemaBreadcrumb } from "../system"

const config: GeradorSistemaConfig = {
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
          screen: { kind: "custom", componentId: "clientes-custom" },
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
