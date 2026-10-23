/**
 * Checkpoints de clarificação da análise (tarefa task-p2-1040).
 *
 * Quando o analista devolve perguntas, o Motor persiste um checkpoint com a
 * sessão/runtime, o executionId que produziu as perguntas, as perguntas e o
 * resumo/evidências disponíveis. Quando a resposta chega, o coordenador
 * localiza o checkpoint pendente mais recente, reivindica-o com fencing por
 * executionId e retoma a análise NA MESMA sessão do analista, sem reenviar a
 * investigação integral.
 *
 * O registro é append-only: rodadas antigas nunca são apagadas — elas
 * transitam para `superseded` (nova rodada/planos concluídos/cancelamento)
 * ou `consumed` (resposta processada pela retomada).
 */

/** Superfície mínima de execução de SQL (pool mysql2 ou conexão transacional). */
export interface CheckpointQueryable {
  query(sql: string, params?: unknown[]): Promise<[any, any]>
}

export type ClarificationCheckpointStatus =
  | 'awaiting_response'
  | 'answered'
  | 'consumed'
  | 'superseded'

/** Registro durável de uma rodada de clarificação. */
export interface ClarificationCheckpointRecord {
  id: number
  taskId: string
  roundNumber: number
  sessionKey: string | null
  runtimeSessionId: string | null
  model: string | null
  modelAttempt: number
  analysisAttemptId: string | null
  /** Execução de análise que emitiu as perguntas (correlação de auditoria). */
  analysisExecutionId: string
  questions: string[]
  summary: string | null
}

/** Resposta do usuário vinculada ao checkpoint. */
export interface ClarificationAnswer {
  chatMessageId: number | null
  texto: string
}

/**
 * Porta de persistência usada pelo TaskCoordinator para retomar a análise
 * incrementalmente. Implementada por MySqlTaskCoordinatorRepository.
 */
export interface ClarificationCheckpointStore {
  findPendingClarificationCheckpoint(taskId: string): Promise<ClarificationCheckpointRecord | null>
  /**
   * Reivindica o checkpoint para a execução de retomada (fencing por
   * executionId). Retorna false quando o checkpoint não está mais disponível
   * (consumido/superado) — o chamador não pode retomar a sessão.
   */
  claimClarificationCheckpoint(checkpointId: number, resumeExecutionId: string, answerChatMessageId: number | null): Promise<boolean>
  /** Marca o checkpoint como consumido; só afeta a execução que o reivindicou. */
  consumeClarificationCheckpoint(checkpointId: number, resumeExecutionId: string): Promise<void>
  /**
   * Localiza a resposta do usuário: pelo chatMessageId informado no comando
   * ou, na ausência dele, pela última mensagem `user` do chat da tarefa.
   */
  findClarificationAnswer(taskId: string, chatMessageId?: number | null): Promise<ClarificationAnswer | null>
}

/** Dados necessários para continuar a análise na sessão anterior. */
export interface ClarificationResumeInput {
  checkpointId: number
  roundNumber: number
  sessionKey: string
  runtimeSessionId: string
  model: string | null
  modelAttempt: number
  analysisAttemptId: string | null
  questions: string[]
  answer: ClarificationAnswer | null
}

export interface ClarificationCheckpointOutcome {
  summary: string
  questions: string[]
  evidence?: string[]
}

/**
 * Invalida checkpoints pendentes/reivindicados da tarefa. Usado antes de
 * inserir uma nova rodada, ao concluir a análise (plano/verificação) e no
 * cancelamento da tarefa. Nunca apaga histórico.
 */
export async function supersedePendingClarificationCheckpoints(queryable: CheckpointQueryable, tarefaId: number): Promise<void> {
  await queryable.query(
    `UPDATE analysis_clarification_checkpoints
        SET status = 'superseded', updated_at = NOW()
      WHERE tarefa_id = ? AND status IN ('awaiting_response', 'answered')`,
    [tarefaId],
  )
}

/**
 * Insere o checkpoint da rodada atual, vinculando sessão/runtime, execução de
 * análise, perguntas e evidências disponíveis. Retorna o id inserido.
 *
 * A sessão é resolvida pela auditoria existente (`analyst_task_sessions`) via
 * executionId — a mesma correlação usada pelo reconciliador de recuperação.
 */
export async function insertClarificationCheckpoint(
  queryable: CheckpointQueryable,
  input: { tarefaId: number; executionId: string; outcome: ClarificationCheckpointOutcome },
): Promise<number | null> {
  const [sessionRows] = await queryable.query(
    `SELECT id, session_key, runtime_session_id, model, model_attempt, analysis_attempt_id
       FROM analyst_task_sessions
      WHERE tarefa_id = ? AND analysis_execution_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [input.tarefaId, input.executionId],
  )
  const session = Array.isArray(sessionRows) ? sessionRows[0] : undefined
  const [roundRows] = await queryable.query(
    'SELECT COALESCE(MAX(round_number), 0) + 1 AS next_round FROM analysis_clarification_checkpoints WHERE tarefa_id = ?',
    [input.tarefaId],
  )
  const roundNumber = Number((Array.isArray(roundRows) ? roundRows[0] : undefined)?.next_round ?? 1)
  const questions = input.outcome.questions ?? []
  if (questions.length === 0) return null
  const [result] = await queryable.query(
    `INSERT INTO analysis_clarification_checkpoints
       (tarefa_id, round_number, session_key, runtime_session_id, model, model_attempt,
        analysis_attempt_id, analysis_execution_id, analyst_session_id, questions, summary, evidence,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_response', NOW(), NOW())`,
    [
      input.tarefaId,
      roundNumber,
      session?.session_key != null ? String(session.session_key) : null,
      session?.runtime_session_id != null ? String(session.runtime_session_id) : null,
      session?.model != null ? String(session.model) : null,
      Number(session?.model_attempt ?? 1),
      session?.analysis_attempt_id != null ? String(session.analysis_attempt_id) : null,
      input.executionId,
      session?.id != null ? Number(session.id) : null,
      JSON.stringify(questions),
      input.outcome.summary ? String(input.outcome.summary) : null,
      Array.isArray(input.outcome.evidence) && input.outcome.evidence.length > 0
        ? JSON.stringify(input.outcome.evidence)
        : null,
    ],
  )
  const insertId = Number(result?.insertId ?? 0)
  return Number.isInteger(insertId) && insertId > 0 ? insertId : null
}

/** Normaliza a coluna JSON de perguntas (mysql2 pode devolver string ou array). */
export function parseCheckpointQuestions(value: unknown): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  return Array.isArray(parsed) ? parsed.map(item => String(item).trim()).filter(Boolean) : []
}
