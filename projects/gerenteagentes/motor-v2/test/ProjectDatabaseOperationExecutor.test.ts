import { describe, expect, it } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolveDatabaseScriptPath, validateDatabaseMigrationPath } from "../src/database/ProjectDatabaseOperationExecutor.js"

describe("ProjectDatabaseOperationExecutor", () => {
  it("aceita somente scripts .sql dentro do worktree", () => {
    expect(resolveDatabaseScriptPath("/tmp/worktree", "migrations/import.sql")).toBe("/tmp/worktree/migrations/import.sql")
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "../outside.sql")).toThrow(/workspace autorizado/)
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "/tmp/import.sql")).toThrow(/caminho relativo/)
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "motor/import.txt")).toThrow(/\.sql/)
  })

  it("aceita migration existente e não oferece caminho de execução", () => {
    const workspace = "/tmp/motor-migration-test"
    mkdirSync(`${workspace}/migrations`, { recursive: true })
    writeFileSync(`${workspace}/migrations/import.sql`, "INSERT INTO clientes (nome) VALUES ('ok');")
    expect(validateDatabaseMigrationPath(workspace, "migrations/import.sql")).toBe(`${workspace}/migrations/import.sql`)
    expect(() => validateDatabaseMigrationPath(workspace, "scripts/import.sql")).toThrow(/migration/)
  })
})
