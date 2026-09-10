/**
 * LegacyCompat - Compatibilidade com tarefas legadas em awaiting_clarification
 *
 * Antes do chat natural com analista (subtarefas 1-9), as tarefas em
 * `awaiting_clarification` usavam um formato diferente:
 * - Mensagens sem `author` (null)
 * - Formato de perguntas numeradas (sem conversa natural)
 * - Sem sessão do analista persistente
 * - Sem proposta de plano estruturada
 *
 * Este módulo fornece funções para:
 * 1. Detectar tarefas legadas em awaiting_clarification
 * 2. Adaptar o histórico para o formato atual (author=null → "legacy-analyst")
 * 3. Criar sessão do analista para tarefas legadas que não têm
 * 4. Permitir que tarefas legadas continuem o fluxo natural sem perda de dados
 *
 * Fluxo de migração:
 * - Tarefa legada em awaiting_clarification é detectada pelo pump
 * - Histórico é adaptado (author null → "legacy-analyst")
 * - Sessão do analista é criada (se não existir)
 * - Tarefa pode receber respostas naturais e seguir para awaiting_approval
 */

import type { Db } from "../shared/types/infrastructure.js"
import { getOrReserveTaskAnalystSession } from "./AnalystSessionStore.js"
import { fetchTaskClarificationHistory, type ChatHistoryEntry } from "./ClarificationStore.js"

export interface LegacyTaskDetection {
  taskId: string
  taskDatabaseId: number
  hasLegacyMessages: boolean
  hasAnalystSession: boolean
  legacyMessageCount: number
}

/**
 * Detecta tarefas legadas em awaiting_clarification que precisam de adaptação.
 *
 * Uma tarefa é considerada "legada" se:
 * - Está em awaiting_clarification
 * - Tem mensagens sem author (formato antigo)
 * - Não tem sessão do analista persistente
 */
export async function detectLegacyAwaitingClarification(
  db: Db,
): Promise<LegacyTaskDetection[]> {
  // Busca tarefas em awaiting_clarification
  const { rows: taskRows } = await db.query(
    "SELECT t.id, t.external_id FROM tarefas t WHERE t.status = 'awaiting_clarification'",
  )

  const results: LegacyTaskDetection[] = []

  for (const row of taskRows) {
    const taskDatabaseId = Number(row.id)
    const taskId = row.external_id != null && String(row.external_id) !== ""
      ? String(row.external_id)
      : String(taskDatabaseId)

    // Verifica se tem mensagens sem author (legado)
    const { rows: legacyMessages } = await db.query(
      "SELECT COUNT(*) as count FROM tarefa_chats WHERE tarefa_id = ? AND role = 'analyst' AND (author IS NULL OR author = '')",
      [taskDatabaseId],
    )
    const legacyMessageCount = Number(legacyMessages[0]?.count ?? 0)

    // Verifica se tem sessão do analista
    const { rows: sessionRows } = await db.query(
      "SELECT id FROM motor_task_analyst_sessions WHERE tarefa_id = ? LIMIT 1",
      [taskDatabaseId],
    )
    const hasAnalystSession = sessionRows.length > 0

    if (legacyMessageCount > 0 || !hasAnalystSession) {
      results.push({
        taskId,
        taskDatabaseId,
        hasLegacyMessages: legacyMessageCount > 0,
        hasAnalystSession,
        legacyMessageCount,
      })
    }
  }

  return results
}

/**
 * Adapta o histórico de uma tarefa legada para o formato atual.
 *
 * Mensagens sem author recebem author="legacy-analyst" (para analyst)
 * ou "legacy-user" (para user). Isso permite que o histórico seja
 * exibido corretamente na interface e reinjetado no prompt do analista.
 *
 * NOTA: Esta função NÃO altera o banco de dados. Retorna uma versão
 * adaptada do histórico para uso em memória.
 */
export function adaptLegacyHistory(entries: readonly ChatHistoryEntry[]): ChatHistoryEntry[] {
  return entries.map((entry) => {
    if (entry.author == null || entry.author === "") {
      const adaptedAuthor = entry.role === "analyst" ? "legacy-analyst" : "legacy-user"
      return { ...entry, author: adaptedAuthor }
    }
    return entry
  })
}

/**
 * Garante que uma tarefa legada tenha uma sessão do analista.
 *
 * Se a tarefa já tem sessão, retorna a sessão existente.
 * Se não tem, cria uma nova sessão com os metadados padrão.
 *
 * Isso permite que tarefas legadas continuem o fluxo natural
 * sem perda de contexto.
 */
export async function ensureLegacyTaskHasAnalystSession(
  db: Db,
  taskId: string,
  options?: { agentId?: string; model?: string },
): Promise<{ sessionKey: string; created: boolean }> {
  const agentId = options?.agentId ?? "legacy-analyst"
  const model = options?.model ?? "default"
  const sessionKey = `analysis-${taskId}`

  // Verifica se já existe sessão antes de tentar criar
  const { rows: existingRows } = await db.query(
    "SELECT id FROM motor_task_analyst_sessions WHERE tarefa_id = (SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1) LIMIT 1",
    [taskId, taskId],
  )
  const alreadyExists = existingRows.length > 0

  const session = await getOrReserveTaskAnalystSession(db, taskId, {
    agentId,
    model,
    sessionKey,
  })

  return { sessionKey: session.sessionKey, created: !alreadyExists }
}

/**
 * Migra uma tarefa legada em awaiting_clarification para o fluxo natural.
 *
 * Combina as operações:
 * 1. Garante que a tarefa tenha sessão do analista
 * 2. Retorna o histórico adaptado para uso no prompt
 *
 * Não altera o status da tarefa — o pump continua responsável por
 * detectar respostas e retomar a análise.
 */
export async function migrateLegacyTaskToNaturalChat(
  db: Db,
  taskId: string,
  options?: { agentId?: string; model?: string },
): Promise<{
  sessionKey: string
  sessionCreated: boolean
  adaptedHistory: ChatHistoryEntry[]
}> {
  // Garante sessão do analista
  const { sessionKey, created } = await ensureLegacyTaskHasAnalystSession(db, taskId, options)

  // Busca e adapta o histórico
  const rawHistory = await fetchTaskClarificationHistory(db, taskId)
  const adaptedHistory = adaptLegacyHistory(rawHistory)

  return {
    sessionKey,
    sessionCreated: created,
    adaptedHistory,
  }
}

/**
 * Verifica se uma tarefa legada pode continuar o fluxo natural.
 *
 * Uma tarefa legada pode continuar se:
 * - Tem sessão do analista (ou pode ser criada)
 * - Tem histórico de mensagens (mesmo que sem author)
 * - Está em awaiting_clarification ou awaiting_approval
 */
export async function canLegacyTaskContinue(
  db: Db,
  taskId: string,
): Promise<{ canContinue: boolean; reason: string | null }> {
  // Resolve task ID
  const isNumeric = /^\d+$/.test(taskId)
  const taskLookupSql = isNumeric
    ? "SELECT id, status FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1"
    : "SELECT id, status FROM tarefas WHERE external_id = ? LIMIT 1"
  const taskLookupParams = isNumeric ? [taskId, taskId] : [taskId]

  const { rows: taskRows } = await db.query(taskLookupSql, taskLookupParams)
  if (!taskRows[0]) {
    return { canContinue: false, reason: "Tarefa não encontrada" }
  }

  const status = String(taskRows[0].status)
  if (status !== "awaiting_clarification" && status !== "awaiting_approval") {
    return { canContinue: false, reason: "Tarefa não está em estado de conversa ou aprovação" }
  }

  const taskDatabaseId = Number(taskRows[0].id)

  // Verifica se tem mensagens no chat
  const { rows: chatRows } = await db.query(
    "SELECT COUNT(*) as count FROM tarefa_chats WHERE tarefa_id = ? AND role IN ('analyst', 'user')",
    [taskDatabaseId],
  )
  const messageCount = Number(chatRows[0]?.count ?? 0)

  if (messageCount === 0) {
    return { canContinue: false, reason: "Tarefa não tem histórico de mensagens" }
  }

  return { canContinue: true, reason: null }
}
