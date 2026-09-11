import { describe, expect, it, vi } from "vitest"
import { persistRemoteSessionFailure } from "../src/workers/TaskWorker.js"

describe("persistência do diagnóstico de falha de sessão", () => {
  it("grava e permite ler todos os campos associados à tarefa e ao agente", async () => {
    const rows = [{
      tarefa_id: 77, subtarefa_id: 8, agent_id: "agente-projeto", session_key: "task-77",
      runtime_session_id: "remote-8", run_id: "run-8", code: "SESSION_BUSY",
      message: "sessão ocupada", occurred_at: "2026-09-08T12:00:00.000Z",
      classification: "transient",
    }]
    const db = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT id FROM tarefas")) return { rows: [{ id: 77 }], affectedRows: 0, insertId: 0 }
      if (sql.startsWith("SELECT")) return [rows]
      return { affectedRows: 1, insertId: 1, rows: [] }
    }) }

    await persistRemoteSessionFailure(db, "77", "agente-projeto", 8, {
      code: "SESSION_BUSY", message: "sessão ocupada", sessionKey: "task-77", remoteSessionId: "remote-8",
      runId: "run-8", occurredAt: "2026-09-08T12:00:00.000Z", scope: "session",
      classification: "transient", classificationReason: "remote_code_or_message_indicates_retryable_failure", fingerprint: "SESSION_BUSY:sessão ocupada",
    })

    const insert = db.query.mock.calls[1]!
    expect(insert[0]).toContain("motor_agent_session_failures")
    expect(insert[1]).toEqual([77, 8, "agente-projeto", "task-77", "remote-8", "run-8", "SESSION_BUSY", "sessão ocupada", "2026-09-08T12:00:00.000Z", "session", "transient", "remote_code_or_message_indicates_retryable_failure", "SESSION_BUSY:sessão ocupada"])
    const [read] = await db.query("SELECT * FROM motor_agent_session_failures WHERE tarefa_id = ?", [77]) as unknown as [typeof rows]
    expect(read[0]).toMatchObject({ tarefa_id: 77, subtarefa_id: 8, agent_id: "agente-projeto", code: "SESSION_BUSY", runtime_session_id: "remote-8", occurred_at: "2026-09-08T12:00:00.000Z" })
  })

  // O worker usa conexão mysql2 crua: `query()` devolve [rows, fields]. Antes da
  // normalização o lookup nunca encontrava a tarefa e nenhuma falha era gravada.
  it("encontra a tarefa quando o driver devolve [rows, fields] (conexão crua do worker)", async () => {
    const db = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id FROM tarefas")) return [[{ id: 792 }], []]
      return [{ affectedRows: 1 }, []]
    }) }

    await persistRemoteSessionFailure(db, "task-p2-792", "programador-senior", 1010, {
      code: "SESSION_FAILED", message: "429 Your token-plan 1-week quota has been exhausted",
      sessionKey: "dev-qwen3.7-plus-task-p2-792-s1010", runId: "run-1", occurredAt: "2026-09-11T17:14:35.709Z",
      scope: "session", classification: "transient", classificationReason: "remote_code_or_message_indicates_retryable_failure", fingerprint: "SESSION_FAILED:429",
    })

    expect(db.query).toHaveBeenCalledTimes(2)
    const insert = db.query.mock.calls[1]!
    expect(insert[0]).toContain("motor_agent_session_failures")
    expect((insert[1] as unknown[])[0]).toBe(792)
  })
})
