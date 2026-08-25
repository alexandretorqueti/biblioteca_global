// @vitest-environment node
/**
 * Contrato do schema Drizzle de projetos_captados — valida a presença e o nome
 * físico da coluna branch_trabalho.
 *
 * Teste versionado sob Vitest: ao atualizar o schema, esta suíte garante que o
 * campo opcional sobreviva a re-generações de migration sem desaparecer.
 */
import { describe, expect, it } from "vitest"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { projetosCaptados, annotations } from "../schema"

describe("projetosCaptados — schema Drizzle", () => {
  it("possui a coluna branch_trabalho (varchar(255), opcional)", () => {
    const config = getTableConfig(projetosCaptados)
    const col = config.columns.find((c) => c.name === "branch_trabalho")

    expect(col).toBeDefined()
    expect(col!.name).toBe("branch_trabalho")
    expect(col!.dataType).toBe("string")
    // Sem .notNull() → notNull é false (opcional/nullável)
    expect((col as any).notNull).toBe(false)
  })

  it("expõe branchTrabalho na tabela Drizzle (prop TS)", () => {
    // drizzle-orm mysqlTable expõe colunas como propriedades diretas do objeto
    expect((projetosCaptados as any).branchTrabalho).toBeDefined()
  })
})

describe("annotations — projetos_captados", () => {
  it("inclui branch_trabalho nas anotações", () => {
    const ann = annotations.projetos_captados
    expect(ann.branch_trabalho).toBeDefined()
    expect(ann.branch_trabalho.label).toBe("Branch de Trabalho")
    expect(ann.branch_trabalho.maxLength).toBe(255)
  })
})
