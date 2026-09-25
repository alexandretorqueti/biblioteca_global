import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const migration = readFileSync(
  resolve(__dirname, "../../migrations/0067_inherit_global_model_selection.sql"),
  "utf8",
)

describe("herança da configuração global ao criar projeto", () => {
  it("materializa as três filas preservando todos os campos", () => {
    expect(migration).toContain("AFTER INSERT ON `projetos_captados`")
    expect(migration).toContain("NEW.`slug`")
    expect(migration).toContain("FROM `global_model_selection`")
    expect(migration).toContain("(`project_slug`, `tipo`, `ordem`, `provider`, `model`, `enabled`)")
    expect(migration).toContain("WHERE NOT EXISTS")
  })

  it("não exige configuração global e não mistura projetos", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS `project_model_selection`")
    expect(migration).toContain("existing.`project_slug` = NEW.`slug`")
  })
})
