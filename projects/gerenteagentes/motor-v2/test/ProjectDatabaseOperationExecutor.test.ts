import { describe, expect, it } from "vitest"
import { resolveDatabaseScriptPath, validateProjectSql } from "../src/database/ProjectDatabaseOperationExecutor.js"

describe("ProjectDatabaseOperationExecutor", () => {
  it("aceita somente scripts .sql dentro do worktree", () => {
    expect(resolveDatabaseScriptPath("/tmp/worktree", "motor/import.sql")).toBe("/tmp/worktree/motor/import.sql")
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "../outside.sql")).toThrow(/workspace autorizado/)
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "/tmp/import.sql")).toThrow(/caminho relativo/)
    expect(() => resolveDatabaseScriptPath("/tmp/worktree", "motor/import.txt")).toThrow(/\.sql/)
  })

  it("recusa comandos que podem escapar do banco do projeto", () => {
    expect(() => validateProjectSql("USE mysql; SELECT 1;")).toThrow(/proibido/)
    expect(() => validateProjectSql("GRANT ALL ON *.* TO 'x'@'%';")).toThrow(/proibido/)
    expect(() => validateProjectSql("INSERT INTO clientes (nome) VALUES ('ok');")).not.toThrow()
  })
})
