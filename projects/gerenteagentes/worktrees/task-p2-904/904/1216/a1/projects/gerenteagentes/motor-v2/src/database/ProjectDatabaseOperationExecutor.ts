import { existsSync } from "node:fs"
import { isAbsolute, resolve, relative } from "node:path"

export function resolveDatabaseScriptPath(workspacePath: string, scriptPath: string): string {
  if (!scriptPath || isAbsolute(scriptPath) || !scriptPath.toLowerCase().endsWith(".sql")) {
    throw new Error("database_operation.script_path deve ser um caminho relativo para um arquivo .sql")
  }
  const workspace = resolve(workspacePath)
  const candidate = resolve(workspace, scriptPath)
  const outside = relative(workspace, candidate)
  if (outside === "" || outside === ".." || outside.startsWith("../") || isAbsolute(outside)) {
    throw new Error("database_operation.script_path precisa permanecer dentro do workspace autorizado")
  }
  return candidate
}

/** Valida o artefato que será versionado; o Motor não executa SQL do agente. */
export function validateDatabaseMigrationPath(workspacePath: string, scriptPath: string): string {
  const absolutePath = resolveDatabaseScriptPath(workspacePath, scriptPath)
  if (!/(^|[\\/])migrations[\\/]/i.test(scriptPath)) {
    throw new Error("database_operation.script_path deve apontar para uma migration")
  }
  if (!existsSync(absolutePath)) throw new Error("Migration indicada pelo agente não existe no workspace")
  return absolutePath
}
