/**
 * ClarificationStore - Clarificação interativa do analista
 * (especificação: docs/ESPECIFICACAO_ANALISTA_INTERATIVO_CHAT.md)
 *
 * Quando o analista encontra ambiguidade na definição, ele pergunta em vez de
 * inventar. As perguntas e respostas ficam registradas no chat da tarefa
 * (`tarefa_chats`) ou no chat do projeto (`projeto_chats`) — as mesmas
 * tabelas que as telas já exibem — e o histórico é reinjetado no prompt do
 * analista na rodada seguinte.
 *
 * Papeis usados:
 * - `analyst` — pergunta do analista (summary + perguntas numeradas)
 * - `user`    — resposta do dono ou do agente do projeto
 *
 * O mecanismo é idêntico para tarefa e projeto; muda apenas a tabela/FK.
 */

import type { Db } from "../shared/types/infrastructure.js"

export const CLARIFICATION_ROLE = "analyst"
export const ANSWER_ROLE = "user"

export interface ClarificationQuestions {
  /** O que o analista já entendeu da tarefa/projeto (obrigatório no prompt). */
  summary: string
  /** Perguntas numeradas exibidas no chat. */
  questions: string[]
}

export interface ChatHistoryEntry {
  role: string
  texto: string
  createdAt: string
}

/** Mensagem única do analista no chat: entendimento + perguntas numeradas. */
export function formatClarificationMessage(input: ClarificationQuestions): string {
  const lines: string[] = ["🤔 O analista precisa de esclarecimentos antes de gerar o plano.", ""]
  const summary = input.summary.trim()
  if (summary) {
    lines.push("Entendimento atual: " + summary, "")
  }
  input.questions.forEach((question, index) => {
    lines.push(`${index + 1}) ${question.trim()}`)
  })
  lines.push("", "Responda neste chat para continuar (ex.: \"1: resposta; 2: resposta\").")
  return lines.join("\n")
}

/** Histórico de clarificação formatado para reinjeção no prompt do analista. */
export function formatHistoryForPrompt(entries: readonly ChatHistoryEntry[]): string {
  if (entries.length === 0) return ""
  const lines = entries.map((entry) => {
    const who = entry.role === CLARIFICATION_ROLE ? "ANALISTA" : "RESPOSTA"
    return `[${who}] ${entry.texto}`
  })
  return lines.join("\n\n")
}

function taskWhereClause(taskId: string): { sql: string; params: unknown[] } {
  if (/^\d+$/.test(taskId)) {
    return {
      sql: "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1",
      params: [taskId, taskId],
    }
  }
  return {
    sql: "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1",
    params: [taskId],
  }
}

async function resolveTaskDatabaseId(db: Db, taskId: string): Promise<number> {
  const lookup = taskWhereClause(taskId)
  const { rows } = await db.query(lookup.sql, lookup.params)
  const databaseTaskId = Number(rows[0]?.id ?? 0)
  if (!databaseTaskId) throw new Error("Tarefa não encontrada: " + taskId)
  return databaseTaskId
}

// ============================================================================
// CHAT DA TAREFA (tarefa_chats)
// ============================================================================

/** Persiste a pergunta do analista como mensagem `analyst` no chat da tarefa. */
export async function persistTaskClarification(
  db: Db,
  taskId: string,
  input: ClarificationQuestions,
): Promise<void> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)
  await db.query(
    "INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, ?, ?, NOW())",
    [databaseTaskId, CLARIFICATION_ROLE, formatClarificationMessage(input)],
  )
}

/** Persiste a resposta do dono/agente do projeto como mensagem `user`. */
export async function persistTaskClarificationAnswer(
  db: Db,
  taskId: string,
  text: string,
): Promise<void> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)
  await db.query(
    "INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, ?, ?, NOW())",
    [databaseTaskId, ANSWER_ROLE, text],
  )
}

/**
 * Histórico de clarificação da tarefa (mensagens analyst/user em ordem).
 * Usado para reinjetar o contexto na próxima rodada do analista.
 */
export async function fetchTaskClarificationHistory(
  db: Db,
  taskId: string,
): Promise<ChatHistoryEntry[]> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)
  const { rows } = await db.query(
    "SELECT role, texto, created_at FROM tarefa_chats " +
    "WHERE tarefa_id = ? AND role IN (?, ?) ORDER BY id ASC",
    [databaseTaskId, CLARIFICATION_ROLE, ANSWER_ROLE],
  )
  return rows.map((row) => ({
    role: String(row.role ?? ""),
    texto: String(row.texto ?? ""),
    createdAt: String(row.created_at ?? ""),
  }))
}

/** Pergunta pendente (última mensagem analyst) — usada no detail da tarefa. */
export async function fetchPendingTaskClarification(
  db: Db,
  taskId: string,
): Promise<{ message: string; askedAt: string } | null> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)
  const { rows } = await db.query(
    "SELECT texto, created_at FROM tarefa_chats " +
    "WHERE tarefa_id = ? AND role = ? ORDER BY id DESC LIMIT 1",
    [databaseTaskId, CLARIFICATION_ROLE],
  )
  const row = rows[0]
  if (!row) return null
  return { message: String(row.texto ?? ""), askedAt: String(row.created_at ?? "") }
}

// ============================================================================
// CHAT DO PROJETO (projeto_chats)
// ============================================================================

/** Persiste a pergunta do analista como mensagem `analyst` no chat do projeto. */
export async function persistProjectClarification(
  db: Db,
  projetoId: number,
  input: ClarificationQuestions,
): Promise<void> {
  await db.query(
    "INSERT INTO projeto_chats (projeto_id, role, texto, created_at) VALUES (?, ?, ?, NOW())",
    [projetoId, CLARIFICATION_ROLE, formatClarificationMessage(input)],
  )
}

/** Persiste a resposta no chat do projeto. */
export async function persistProjectClarificationAnswer(
  db: Db,
  projetoId: number,
  text: string,
): Promise<void> {
  await db.query(
    "INSERT INTO projeto_chats (projeto_id, role, texto, created_at) VALUES (?, ?, ?, NOW())",
    [projetoId, ANSWER_ROLE, text],
  )
}

/** Histórico de clarificação do projeto. */
export async function fetchProjectClarificationHistory(
  db: Db,
  projetoId: number,
): Promise<ChatHistoryEntry[]> {
  const { rows } = await db.query(
    "SELECT role, texto, created_at FROM projeto_chats " +
    "WHERE projeto_id = ? AND role IN (?, ?) ORDER BY id ASC",
    [projetoId, CLARIFICATION_ROLE, ANSWER_ROLE],
  )
  return rows.map((row) => ({
    role: String(row.role ?? ""),
    texto: String(row.texto ?? ""),
    createdAt: String(row.created_at ?? ""),
  }))
}
