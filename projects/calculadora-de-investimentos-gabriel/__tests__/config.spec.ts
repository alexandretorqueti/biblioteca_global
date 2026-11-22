// @vitest-environment node
/**
 * Valida a config versionada do projeto `calculadora-de-investimentos-gabriel`
 * (plano macro #6, posição 1/9 — subtarefa 3): menu 'Investimentos' com a
 * tela cadastro de Índices (CRUD genérico, ordenação por `ordem`) e a rota
 * custom da Calculadora, conforme o contrato serializável do shared.
 *
 * Espelha o padrão de projects/gerenteagentes/__tests__/config.spec.ts.
 */
import { describe, expect, it } from "vitest"
import { geradorSistemaConfigSchema } from "@biblioteca-global/shared"
import { config } from "../config"
import type { CadastroScreenConfig } from "@biblioteca-global/shared"

describe("configuração do projeto calculadora-de-investimentos-gabriel", () => {
  it("é aceita pelo contrato GeradorSistemaConfig do shared", () => {
    expect(() => geradorSistemaConfigSchema.parse(config)).not.toThrow()
  })

  it("expõe o menu Investimentos com rotas /indices e /calculadora", () => {
    const grupo = config.groups.find((g) => g.id === "investimentos")
    expect(grupo, "grupo investimentos deve existir").toBeDefined()
    expect(grupo?.label).toBe("Investimentos")

    const rotas = grupo!.items.map((item) => item.path)
    expect(rotas).toEqual(expect.arrayContaining(["indices", "calculadora"]))
  })

  it("Índices: tela cadastro sobre o resource indices com colunas das annotations e ordenação por ordem", () => {
    const item = config.groups
      .flatMap((g) => g.items)
      .find((i) => i.id === "indices-list")
    expect(item, "item indices-list deve existir").toBeDefined()
    expect(item!.screen.kind).toBe("cadastro")
    if (item!.screen.kind !== "cadastro") return

    const screen = item!.screen as CadastroScreenConfig
    expect(screen.resource).toBe("indices")

    // Labels derivadas das annotations do schema.ts (fonte única).
    const porNome = new Map(screen.fields?.map((f) => [f.name, f]))
    expect(porNome.get("nome")?.label).toBe("Nome")
    expect(porNome.get("sigla")?.label).toBe("Sigla")
    expect(porNome.get("taxaAnual")?.label).toBe("Taxa anual (% a.a.)")
    expect(porNome.get("fonteCotacao")?.label).toBe("Fonte da cotação")
    expect(porNome.get("ordem")?.label).toBe("Ordem")

    // CRUD genérico completo: listar/criar/editar/excluir é o comportamento
    // padrão da tela cadastro — nada desabilita as ações.
    expect(screen.overrides?.newLabel).toBe("Novo índice")

    // Seed: os 4 índices aparecem ordenados por 'ordem'.
    expect(screen.defaultOrderBy).toEqual([{ campo: "ordem", direction: "asc" }])
  })

  it("Calculadora: rota custom via componentId registrado no registry do projeto", async () => {
    const item = config.groups
      .flatMap((g) => g.items)
      .find((i) => i.id === "calculadora-view")
    expect(item, "item calculadora-view deve existir").toBeDefined()
    expect(item!.path).toBe("calculadora")
    expect(item!.screen.kind).toBe("custom")
    if (item!.screen.kind !== "custom") return

    const { customScreens } = await import("../screens/registry")
    expect(customScreens[item!.screen.componentId]).toBeDefined()
  })
})
