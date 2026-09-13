import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { taskIdentifierLookup } from "./TaskIdentifierLookup.js"
import { isAbsolute, resolve, relative } from "node:path"
import mysql from "mysql2/promise"
import type { Db } from "../shared/types/infrastructure.js"

export interface DatabaseOperationRequest {
  taskId: string
  workspacePath: string
  scriptPath: string
}

export interface DatabaseOperationResult {
  database: string
  scriptPath: string
  sha256: string
}

const FORBIDDEN_SQL = /\b(?:use|create\s+(?:database|user)|drop\s+(?:database|user)|alter\s+(?:database|user)|grant|revoke|set\s+(?:global|persist)|load\s+data|load_file|into\s+outfile|into\s+dumpfile|shutdown|flush\s+(?:tables|privileges)|kill)\b/i

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

export function validateProjectSql(sql: string): void {
  if (!sql.trim()) throw new Error("O script SQL está vazio")
  if (Buffer.byteLength(sql, "utf8") > 5 * 1024 * 1024) throw new Error("O script SQL excede o limite de 5 MiB")
  if (FORBIDDEN_SQL.test(sql)) throw new Error("O script SQL contém comando proibido fora do banco do projeto")
}

export class ProjectDatabaseOperationExecutor {
  async execute(motorDb: Db, request: DatabaseOperationRequest): Promise<DatabaseOperationResult> {
    const absolutePath = resolveDatabaseScriptPath(request.workspacePath, request.scriptPath)
    const sql = await readFile(absolutePath, "utf8")
    validateProjectSql(sql)

    const lookup = taskIdentifierLookup(request.taskId, "t")
    const { rows } = await motorDb.query(
      "SELECT pc.plataforma_projeto_id FROM tarefas t INNER JOIN projetos_captados pc ON pc.id = t.projeto_id WHERE " + lookup.sql + " LIMIT 1",
      lookup.params,
    )
    const platformProjectId = Number(rows[0]?.plataforma_projeto_id ?? 0)
    if (!Number.isSafeInteger(platformProjectId) || platformProjectId < 1) {
      throw new Error("Não foi possível resolver o projeto da Biblioteca para executar a operação de banco")
    }
    const database = `projeto_${platformProjectId}`
    const connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST ?? "mysql",
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASSWORD ?? "",
      database,
      multipleStatements: true,
    })
    try {
      await connection.query(sql)
    } finally {
      await connection.end()
    }
    return { database, scriptPath: request.scriptPath, sha256: createHash("sha256").update(sql).digest("hex") }
  }
}
