/**
 * Implementação de Db e TaskRepository usando mysql2 puro
 */

import mysql from "mysql2/promise"
import type { Db, QueryResult, TaskRepository, SaveTaskData } from "../shared/types/infrastructure.js"

export async function createDbConnection(): Promise<{ db: Db; connection: mysql.Connection }> {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3308),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "projeto_640",
  })

  const db: Db = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const [rows] = await connection.execute(sql, params as mysql.ExecuteValues | undefined)
      if (Array.isArray(rows)) {
        return { rows: rows as Record<string, unknown>[], affectedRows: 0, insertId: 0 }
      } else {
        const result = rows as { affectedRows?: number; insertId?: number }
        return { rows: [], affectedRows: result.affectedRows ?? 0, insertId: result.insertId ?? 0 }
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

export class MysqlTaskRepository implements TaskRepository {
  constructor(private db: Db) {}

  async getTask(id: string): Promise<SaveTaskData | null> {
    const isNumericId = /^\d+$/.test(id)
    const whereClause = isNumericId
      ? "WHERE t.external_id = ? OR t.id = ?"
      : "WHERE t.external_id = ?"
    const params = isNumericId ? [id, id] : [id]

    const { rows } = await this.db.query(
      `SELECT t.id, t.external_id, t.titulo, t.descricao, t.status,
              t.max_rework, t.hard_timeout_ms, t.depends_on_task_id,
              t.created_at, t.updated_at,
              pc.slug as project_slug, pc.repo_path, a.id as agent_id
       FROM projeto_640.tarefas t
       LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id
       LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id
       ${whereClause} LIMIT 1`,
      params
    )
    if (rows.length === 0) return null
    return this.mapRowToTask(rows[0]!)
  }

  async saveTask(data: SaveTaskData): Promise<void> {
    const existing = await this.getTask(data.id)

    if (existing) {
      // UPDATE - NAO sobrescrever external_id com executionId!
      const updates: string[] = ["status = ?"]
      const values: unknown[] = [data.status]

      if (data.errorMessage) {
        updates.push("descricao = ?")
        values.push(data.errorMessage)
      }
      if (data.completedAt) {
        updates.push("completed_at = ?")
        values.push(data.completedAt)
      }
      updates.push("updated_at = NOW()")

      const isNumericId = /^\d+$/.test(data.id)
      const whereClause = isNumericId
        ? "WHERE external_id = ? OR id = ?"
        : "WHERE external_id = ?"
      const whereParams = isNumericId ? [data.id, data.id] : [data.id]

      await this.db.query(
        `UPDATE projeto_640.tarefas SET ${updates.join(", ")} ${whereClause}`,
        [...values, ...whereParams]
      )
    } else {
      await this.db.query(
        `INSERT INTO projeto_640.tarefas
         (external_id, projeto_id, titulo, descricao, status, max_rework, hard_timeout_ms, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [data.id, data.title, data.description ?? "", data.status, data.maxRework ?? 3, data.hardTimeoutMs ?? 3600000]
      )
    }
  }

  private mapRowToTask(row: Record<string, unknown>): SaveTaskData {
    return {
      id: String(row.external_id ?? row.id ?? ""),
      chatId: "",
      title: String(row.titulo ?? ""),
      description: String(row.descricao ?? ""),
      status: String(row.status ?? "planned"),
      repoPath: String(row.repo_path ?? ""),
      agentId: String(row.agent_id ?? ""),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      buildCommand: "npm run build",
      unitTestCommand: "npm run test",
      maxRework: Number(row.max_rework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? 3600000),
      dependsOnTaskId: row.depends_on_task_id ? String(row.depends_on_task_id) : undefined,
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    }
  }
}
