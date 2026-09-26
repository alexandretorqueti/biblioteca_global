// @vitest-environment node
import { describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { config } from "../../../../../../projects/sistema-adm-global/config"
import { clientes } from "../../../../../../projects/sistema-adm-global/schema"
import { DynamicSchemaRegistry } from "../schema-registry"

describe("contrato integrado do Instagram de clientes", () => {
  it("mantém o campo no schema e na configuração do cadastro", () => {
    expect(Object.keys(getTableColumns(clientes))).toContain("instagram")

    const telaClientes = config.groups
      .flatMap((grupo) => grupo.items)
      .find((item) => item.screen.kind === "cadastro" && item.screen.resource === "clientes")

    expect(telaClientes?.screen.kind).toBe("cadastro")
    if (telaClientes?.screen.kind === "cadastro") {
      expect(telaClientes.screen.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "instagram",
            label: "Instagram",
            type: "text",
          }),
        ]),
      )
    }
  })

  it("carrega clientes com Instagram no registry dinâmico", async () => {
    const registry = new DynamicSchemaRegistry()
    await registry.onModuleInit()

    const tabela = registry.tabelasDoProjeto("sistema-adm-global")?.clientes
    expect(tabela).toBeDefined()
    expect(tabela && Object.keys(getTableColumns(tabela))).toContain("instagram")
  })
})
