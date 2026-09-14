// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  resolve(process.cwd(), "projects/gerenteagentes/motor-v2/scripts/deploy-blue-green.sh"),
  "utf8",
)
const normalizedScript = script.replace(/\s+/g, " ")

describe("deploy de produção isolado do banco", () => {
  it("recria api/web sem administrar dependências no deploy e no rollback", () => {
    expect(normalizedScript).toContain("docker compose -p \"$NEW_PROJECT\" -f \"$COMPOSE_FILE\" build api web")
    expect(normalizedScript).toContain("docker compose -p \"$NEW_PROJECT\" -f \"$COMPOSE_FILE\" up -d --no-deps api web")
    expect(normalizedScript).not.toContain("up -d --no-deps mysql")
  })

  it("confere saúde e preserva a identidade do MySQL", () => {
    expect(script).toContain("MYSQL_HOST_BLUEGREEN")
    expect(script).toContain("MYSQL_PORT_BLUEGREEN")
    expect(script).toContain("MySQL é")
    expect(script).toContain("nunca é recriado")
  })
})
