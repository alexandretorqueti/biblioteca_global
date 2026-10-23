import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TerminalFailureContext, TerminalFailureMessageHandler } from '../queue/TerminalFailureHandler.js'
import { insertOutboxMessage } from '../queue/outboxInsert.js'
import { createTaskBlockedMessage } from '../monitor/index.js'
import type { RealtimeMutationBoundary } from '../realtime/RealtimeMutationBoundary.js'
import { insertBlockerChatAlert, recommendedActionForBlockReason } from './blockerChatAlert.js'
import { SUBTASK_VERIFICATION_REQUESTED } from './SubtaskVerificationConsumer.js'

/**
 * Persiste bloqueio idempotente quando uma subtarefa atinge falha terminal
 * na fila (ex.: HTTP 504 do Console, timeout do worker, erro de preparação
 * recorrente, falha definitiva de verificação como
 * `MigrationJournalIntegrityError`).
 *
 * Padrão derivado do `MySqlAnalysisFailureBlocker`:
 * - INSERT em `bloqueios` com NOT EXISTS para evitar duplicatas
 * - UPDATE da subtarefa para `blocked` na mesma transação
 *   (cobre `running`/`pending` no fluxo de execução e `verifying` no fluxo
 *   de verificação)
 * - Emissão de `TASK_BLOCKED` via outbox para o Monitor-Resolvedor
 * - Diagnóstico acionável em `block_excerpt` (origem, executionId, subtarefa,
 *   tentativa, erro; para falhas do gate de migrations, inclui a lista de
 *   migrations órfãs/tags esperadas e violações de monotonicidade do journal)
 * - Alerta ao operador em `tarefa_chats` na mesma transação do bloqueio,
 *   idempotente por marcador do blockId no texto da mensagem (tarefa 1043:
 *   falha terminal não pode ficar sem notificação humana)
 *
 * Idempotência: redelivery da mesma mensagem não cria bloqueio duplicado
 * (NOT EXISTS em `bloqueios` por `block_reason` + `subtarefa_id` ativa),
 * respeitando o mesmo `block_reason` dedicado ao fluxo da mensagem.
 */
export class SubtaskTerminalFailureBlocker {
  constructor(
    private readonly pool: Pool,
    /** Fronteira realtime opcional para publicar a mensagem de chat criada. */
    private readonly realtime?: RealtimeMutationBoundary,
  ) {}

  /**
   * Handler compatível com `TerminalFailureMessageHandler` — chamado pelo
   * `TerminalFailureRouter` antes do envio à DLQ.
   */
  readonly handle: TerminalFailureMessageHandler = async (context: TerminalFailureContext) => {
    await this.blockForTerminalFailure(context)
  }

  async blockForTerminalFailure(context: TerminalFailureContext): Promise<void> {
    const { message, attempt, reason, error } = context
    const subtaskId = Number(message.payload?.subtaskId)
    if (!Number.isInteger(subtaskId) || subtaskId <= 0) {
      // Mensagem sem subtaskId válido — não há o que bloquear.
      // O roteador loga e segue para DLQ sem persistir bloqueio órfão.
      console.warn(`[SubtaskTerminalFailureBlocker] mensagem ${message.messageId} sem subtaskId válido; bloqueio omitido`)
      return
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorName = error instanceof Error && error.name ? error.name : 'Error'
    // Motivo dedicado por fluxo: verificação usa 'subtask_verification_failed'
    // e não colide com bloqueios de execução; os demais tipos (ex.:
    // SUBTASK_EXECUTION_REQUESTED) mantêm 'subtask_terminal_failure'.
    const blockReason = message.type === SUBTASK_VERIFICATION_REQUESTED
      ? 'subtask_verification_failed'
      : 'subtask_terminal_failure'
    const blockCommand = `motor-v3:terminal:${message.type}`
    const migrationDiagnostics = extractMigrationDiagnostics(error)
    const blockExcerpt = JSON.stringify({
      messageType: message.type,
      executionId: message.executionId,
      subtaskId,
      attempt,
      reason: reason.slice(0, 500),
      error: errorMessage.slice(0, 1400),
      errorName,
      ...(migrationDiagnostics ? { migrationDiagnostics } : {}),
      messageId: message.messageId,
    })

    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      // 1. INSERT bloqueio idempotente (NOT EXISTS por subtarefa + reason ativo)
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at)
         SELECT s.tarefa_id, s.id, ?, ?, ?, NOW()
           FROM subtarefas s
          WHERE s.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM bloqueios b
               WHERE b.tarefa_id = s.tarefa_id
                 AND b.subtarefa_id = s.id
                 AND b.block_reason = ?
                 AND b.resolved_at IS NULL
            )
          LIMIT 1`,
        [blockReason, blockCommand, blockExcerpt, subtaskId, blockReason],
      )

      if (result.affectedRows === 0) {
        // Bloqueio já existe ou subtarefa inexistente — idempotência OK.
        await connection.commit()
        return
      }

      // 2. Atualizar status da subtarefa para 'blocked' (se ainda ativa:
      //    running/pending no fluxo de execução; verifying no fluxo de
      //    verificação — falha terminal da verificação não pode deixar
      //    trabalho em 'verifying' sem heartbeat). Subtarefas já finalizadas
      //    ou blocked não são reabertas.
      await connection.query(
        `UPDATE subtarefas SET status='blocked', resultado=?, updated_at=NOW()
          WHERE id=? AND status IN ('running','pending','verifying')`,
        [errorMessage.slice(0, 60_000), subtaskId],
      )

      // 3. Buscar ids para o evento TASK_BLOCKED
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; tarefa_id: number }>>(
        `SELECT b.id, b.tarefa_id FROM bloqueios b
          WHERE b.subtarefa_id = ? AND b.block_reason = ? AND b.resolved_at IS NULL
          ORDER BY b.id DESC LIMIT 1`,
        [subtaskId, blockReason],
      )
      const blockRow = rows[0]

      // 4. Emitir TASK_BLOCKED via outbox (mesma transação)
      const blocked = createTaskBlockedMessage({
        taskId: message.taskId,
        executionId: `${message.executionId}-terminal-block`,
        correlationId: message.correlationId ?? message.messageId,
        causationId: message.messageId,
        payload: {
          blockReason,
          blockCommand,
          blockExcerpt: blockExcerpt.slice(0, 500),
          subtaskId,
          blockId: blockRow?.id != null ? Number(blockRow.id) : null,
          databaseTaskId: blockRow?.tarefa_id != null ? Number(blockRow.tarefa_id) : null,
        },
      })
      await insertOutboxMessage(connection, blocked, 'motor.monitor')

      // 5. Alerta ao operador no chat da tarefa, na mesma transação e
      //    idempotente pelo marcador do blockId (redelivery não duplica).
      if (blockRow?.id != null && blockRow?.tarefa_id != null) {
        const databaseTaskId = Number(blockRow.tarefa_id)
        const alert = await insertBlockerChatAlert(connection, {
          databaseTaskId,
          blockId: Number(blockRow.id),
          taskId: String(message.taskId),
          subtaskId,
          blockReason,
          cause: errorMessage,
          evidence: blockExcerpt,
          nextStep: recommendedActionForBlockReason(blockReason),
        })
        if (alert && this.realtime) {
          await this.realtime.appendChatMessage(connection, databaseTaskId, {
            id: alert.id, role: 'assistant', texto: alert.texto,
          })
        }
      }

      await connection.commit()
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }
  }
}

interface MigrationProblemDiag {
  project: string
  migration: string
  expectedTag: string
}

interface MonotonicityViolationDiag {
  project: string
  entryTag: string
  entryIndex: number
  currentWhen: number
  previousWhen: number
  previousTag: string
}

interface MigrationDiagnostics {
  errorType: string
  journalIssue?: string | null
  orphanedMigrations?: MigrationProblemDiag[]
  monotonicityViolations?: MonotonicityViolationDiag[]
  violations?: Array<{ project: string; migration: string; orphanedStatementLine: number; kind: string }>
}

/**
 * Estrutura os problemas do gate de migrations (erros de
 * `MigrationJournalIntegrity.ts`) no `block_excerpt`, para que o
 * Monitor-Resolvedor tenha a lista de migrations/journal problemática sem
 * depender de parser do texto livre da mensagem.
 *
 * Detecção duck-typed: evita import circular (o módulo de migrations puxa
 * fs/child_process) e cobre os três erros do gate diferencial.
 */
function extractMigrationDiagnostics(error: unknown): MigrationDiagnostics | null {
  if (!(error instanceof Error)) return null
  const err = error as unknown as Record<string, unknown>
  const name = error.name

  if (name === 'MigrationJournalIntegrityError' && Array.isArray(err.problems)) {
    const problems = err.problems as MigrationProblemDiag[]
    const inspections = Array.isArray(err.inspections) ? (err.inspections as Array<{ issue?: unknown }>) : []
    return {
      errorType: name,
      journalIssue: inspections.find(i => typeof i?.issue === 'string')?.issue as string ?? null,
      orphanedMigrations: problems.slice(0, 50).map(p => ({
        project: String(p.project), migration: String(p.migration), expectedTag: String(p.expectedTag),
      })),
    }
  }
  if (name === 'MigrationJournalMonotonicityError' && Array.isArray(err.violations)) {
    const violations = err.violations as MonotonicityViolationDiag[]
    return {
      errorType: name,
      monotonicityViolations: violations.slice(0, 50).map(v => ({
        project: String(v.project), entryTag: String(v.entryTag), entryIndex: Number(v.entryIndex),
        currentWhen: Number(v.currentWhen), previousWhen: Number(v.previousWhen), previousTag: String(v.previousTag),
      })),
    }
  }
  if (name === 'MigrationStatementBreakpointError' && Array.isArray(err.violations)) {
    const violations = err.violations as Array<Record<string, unknown>>
    return {
      errorType: name,
      violations: violations.slice(0, 50).map(v => ({
        project: String(v.project), migration: String(v.migration),
        orphanedStatementLine: Number(v.orphanedStatementLine), kind: String(v.kind),
      })),
    }
  }
  return null
}
