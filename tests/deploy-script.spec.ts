// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  resolve(process.cwd(), "projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh"),
  "utf8",
)

describe("deploy de produção isolado do banco", () => {
  it("recria api/web sem administrar dependências no deploy e no rollback", () => {
    const composeUp = script.match(/docker compose[^\n]+ up [^\n]+/g) ?? []

    // api e web são criados em chamadas separadas (o Nginx do web precisa do
    // alias DNS da API já existente); cada chamada deve ser isolada de dependências.
    expect(composeUp).toHaveLength(2)
    for (const command of composeUp) {
      expect(command).toContain("--no-deps")
      expect(command).toMatch(/\b(api|web)\b/)
      expect(command).not.toMatch(/\bmysql\b/)
    }
    expect(composeUp[0]).toMatch(/\bapi\b/)
    expect(composeUp[1]).toMatch(/\bweb\b/)
  })

  it("confere saúde e preserva a identidade do MySQL", () => {
    expect(script).toContain("MYSQL_HOST_BLUEGREEN")
    expect(script).toContain("MYSQL_PORT_BLUEGREEN")
    expect(script).toContain("MySQL é")
    expect(script).toContain("compartilhado e nunca é recriado")
  })
})
