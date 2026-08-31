// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(resolve(process.cwd(), "deploy.sh"), "utf8")

describe("deploy de produção isolado do banco", () => {
  it("recria api/web sem administrar dependências no deploy e no rollback", () => {
    const composeUp = script.match(/docker compose[^\n]+ up [^\n]+/g) ?? []

    expect(composeUp).toHaveLength(2)
    for (const command of composeUp) {
      expect(command).toContain("--no-deps")
      expect(command).toMatch(/\bapi web\b/)
      expect(command).not.toMatch(/\bmysql\b/)
    }
  })

  it("confere saúde e preserva a identidade do MySQL", () => {
    expect(script).toContain("MYSQL_HEALTH")
    expect(script).toContain("MYSQL_ID_BEFORE")
    expect(script).toContain("MYSQL_ID_AFTER")
    expect(script).toContain('[ "$MYSQL_ID_BEFORE" = "$MYSQL_ID_AFTER" ]')
  })
})
