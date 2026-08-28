/**
 * Implementação real de Db e TaskRepository usando mysql2 puro
 * 
 * Usa SQL direto para evitar conflitos de tipo com Drizzle ORM.
 * A integração com Drizzle pode ser feita depois quando necessário.
 */

import mysql from "mysql2/promise"
import type { Db, QueryResult, TaskRepository, SaveTaskData } from "../shared/types/infrastructure.js"

/**
 * Cria conexão com o banco e retorna implementação de Db
 */
export async function createDbConnection(): Promise<{ db: Db; connection: mysql.Connection }> {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3308),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: "projeto_640",
  })

  const db: Db = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const [rows] = await connection.execute(sql, params as mysql.ExecuteValues | undefined)
      
      if (Array.isArray(rows)) {
        return {
          rows: rows as Record<string, unknown>[],
          affectedRows: 0,
          insertId: 0,
        }
      } else {
        const result = rows as { affectedRows?: number; insertId?: number }
        return {
          rows: [],
          affectedRows: result.affectedRows ?? 0,
          insertId: result.insertId ?? 0,
        }
      }
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      await connection.beginTransaction()
      try {
        const result = await fn(db)
        await connection.commit()
        return result
      } catch (error) {
        await connection.rollback()
        throw error
      }
    },
  }

  return { db, connection }
}

/**
 * Implementação de TaskRepository usando SQL puro
 */
export class MysqlTaskRepository implements TaskRepository {
  constructor(private db: Db) {}

  async getTask(id: string): Promise<SaveTaskData | null> {
    const { rows } = await this.db.query(
      `SELECT 
         t.id,
         t.external_id,
         t.titulo,
         t.descricao,
         t.status,
         t.max_rework,
         t.hard_timeout_ms,
         t.depends_on_task_id,
         t.created_at,
         t.updated_at,
         pc.slug as project_slug,
         pc.repo_path,
         a.external_id as agent_id
       FROM projeto_640.tarefas t
       LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id
       LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id
       WHERE t.external_id = ?
       LIMIT 1`,
      [id]
    )

    if (rows.length === 0) return null

    const row = rows[0]!
    return this.mapRowToTask(row)
  }

  async saveTask(data: SaveTaskData): Promise<void> {
    const existing = await this.getTask(data.id)

    if (existing) {
      // UPDATE
      const updates: string[] = ["status = ?"]
      const values: unknown[] = [data.status]

      if (data.executionId) {
        updates.push("external_id = ?")
        values.push(data.executionId)
      }

      if (data.errorMessage) {
        updates.push("descricao = ?")
        values.push(data.errorMessage)
      }

      updates.push("updated_at = NOW()")
      values.push(data.id)

      await this.db.query(
        `UPDATE projeto_640.tarefas SET ${updates.join(", ")} WHERE external_id = ?`,
        values
      )
    } else {
      // INSERT
      await this.db.query(
        `INSERT INTO projeto_640.tarefas 
         (external_id, projeto_id, titulo, descricao, status, max_rework, hard_timeout_ms, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          data.id,
          data.title,
          data.description,
          data.status,
          data.maxRework,
          data.hardTimeoutMs,
        ]
      )
    }
  }

  private mapRowToTask(row: Record<string, unknown>): SaveTaskData {
    return {
      id: String(row.external_id ?? row.id),
      chatId: "",
      agentId: String(row.agent_id ?? ""),
      title: String(row.titulo ?? ""),
      description: String(row.descricao ?? ""),
      repoPath: String(row.repo_path ?? ""),
      buildCommand: "",
      unitTestCommand: "",
      status: String(row.status ?? "planned"),
      maxRework: Number(row.max_rework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? 3600000),
      dependsOnTaskId: row.depends_on_task_id ? String(row.depends_on_task_id) : undefined,
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      executionId: row.external_id ? String(row.external_id) : undefined,
      createdAt: row.created_at instanceof Date 
        ? row.created_at.toISOString() 
        : String(row.created_at ?? new Date().toISOString()),
      updatedAt: row.updated_at instanceof Date 
        ? row.updated_at.toISOString() 
        : String(row.updated_at ?? new Date().toISOString()),
    }
  }
}
