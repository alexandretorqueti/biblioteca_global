import { randomUUID } from 'node:crypto'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/QueueMessage.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'
import type { AnalysisRunner, TaskSnapshot } from '../coordinator/TaskCoordinator.js'
import type { OperationLogger } from '../commands/OperationLogger.js'
import type { AnalysisOutcome } from '../analysis/AnalystReply.js'

export const TASK_ADJUSTMENT_REQUESTED = 'TASK_ADJUSTMENT_REQUESTED'

export interface AdjustmentTaskContext {
  databaseTaskId: number
  taskId: string
  title: string
  description: string
  taskType: string
  projectSlug: string | null
  agentId: string
  repoPath: string
  currentGeneration: number
  nextGeneration: number
  previousSubtasks: Array<{
    seq: number
    titulo: string
    status: string
    generation: number
    commit_sha: string | null
  }>
}

/**
 * Consome TASK_ADJUSTMENT_REQUESTED e dispara uma nova rodada de análise
 * incremental. Monta o prompt com contexto completo da tarefa (descrição
 * original, subtarefas das generations anteriores, mensagem de ajuste do
 * usuário) e chama o ConsoleAnalystRunner. As subtarefas resultantes são
 * criadas com generation = nextGeneration.
 */
export class TaskAdjustmentConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly analyst: AnalysisRunner,
    private readonly logger?: OperationLogger,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== TASK_ADJUSTMENT_REQUESTED) return
    const operationId = randomUUID()
    const taskId = message.taskId
    const generation = Number(message.payload.generation ?? 1)
    const adjustmentMessage = String(message.payload.message ?? '')

    await this.log(operationId, 1, 'received', 'executed', message, { taskId, generation })

    // 1. Carregar contexto da tarefa
    const context = await this.loadContext(taskId, generation)
    if (!context) {
      await this.log(operationId, 2, 'rejected', 'skipped', message, { reasonCode: 'task_not_found_or_invalid' })
      return
    }

    // 2. Montar prompt do analista com contexto de ajuste incremental
    const prompt = this.buildAdjustmentPrompt(context, adjustmentMessage)

    // 3. Registrar mensagem do usuário no chat da tarefa
    await this.pool.query(
      `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'user', ?, NOW())`,
      [context.databaseTaskId, adjustmentMessage],
    )

    // 4. Construir snapshot da tarefa para o analista
    const snapshot: TaskSnapshot = {
      taskId: context.taskId,
      title: context.title,
      description: prompt,
      taskType: context.taskType,
      agentId: context.agentId,
      projectSlug: context.projectSlug,
      repoPath: context.repoPath,
      status: 'deployed',
      paused: false,
      terminal: false,
      analysisStartedAt: null,
      subtaskCount: 0, // O coordinator vai criar as subtarefas
    }

    // 5. Reivindicar análise (limpa o analysis_started_at anterior para permitir nova análise)
    const executionId = `exec-adjustment-${taskId}-gen${generation}-${Date.now()}`
    await this.pool.query(
      `UPDATE task_runtime_facts
          SET analysis_started_at = NOW(), analysis_execution_id = ?,
              terminal_status = NULL, terminal_at = NULL,
              integration_confirmed_at = NULL,
              updated_at = NOW()
        WHERE tarefa_id = ?`,
      [executionId, context.databaseTaskId],
    )

    // 6. Chamar o analista
    let outcome: AnalysisOutcome
    try {
      outcome = await this.analyst.start(snapshot, executionId)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.log(operationId, 2, 'primitive', 'failed', message, {
        primitiveCode: 'start_analyst_adjustment',
        result: { error: errorMessage },
      })
      throw error
    }

    await this.log(operationId, 2, 'primitive', 'succeeded', message, {
      primitiveCode: 'start_analyst_adjustment',
      result: { outcomeKind: outcome.kind, subtaskCount: outcome.kind === 'plan' ? outcome.subtasks.length : 0 },
    })

    // 7. Persistir subtarefas com generation = nextGeneration
    if (outcome.kind === 'plan') {
      await this.persistAdjustmentSubtasks(context.databaseTaskId, context.nextGeneration, outcome)

      // Registrar resposta do analista no chat
      const summary = outcome.subtasks.map(s => `${s.seq}. ${s.titulo}`).join('\n')
      await this.pool.query(
        `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'analyst', ?, NOW())`,
        [context.databaseTaskId, `Ajuste generation ${context.nextGeneration}: ${outcome.subtasks.length} subtarefas criadas.\n${summary}`],
      )
    } else {
      // Perguntas — registrar no chat
      await this.pool.query(
        `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'analyst', ?, NOW())`,
        [context.databaseTaskId, JSON.stringify({ summary: outcome.summary, questions: outcome.questions })],
      )
    }

    // 8. Liberar o claim de análise para o fluxo normal continuar
    await this.pool.query(
      `UPDATE task_runtime_facts SET analysis_execution_id = NULL, updated_at = NOW() WHERE tarefa_id = ?`,
      [context.databaseTaskId],
    )

    // 9. Emitir TASK_READY_FOR_PROGRAMMING se há subtarefas
    if (outcome.kind === 'plan' && outcome.subtasks.length > 0) {
      const readyMessage = createQueueMessage({
        type: 'TASK_READY_FOR_PROGRAMMING',
        taskId,
        executionId,
        correlationId: message.correlationId ?? message.messageId,
        causationId: message.messageId,
        payload: {
          reason: 'adjustment',
          generation,
          subtaskCount: outcome.subtasks.length,
        },
      })
      await insertOutboxMessage(this.pool as any, readyMessage)
      await this.log(operationId, 3, 'completed', 'succeeded', message, {
        result: { generation, subtaskCount: outcome.subtasks.length },
      })
    } else {
      await this.log(operationId, 3, 'completed', 'succeeded', message, {
        result: { generation, outcomeKind: outcome.kind },
      })
    }
  }

  private async loadContext(taskId: string, expectedGeneration: number): Promise<AdjustmentTaskContext | null> {
    const [taskRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.id, t.external_id, t.titulo, t.descricao, t.tipo,
              pc.slug AS project_slug,
              COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug, '') AS agent_id,
              pmc.repo_path
         FROM tarefas t
         LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
         LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
         LEFT JOIN agentes a ON a.id = pc.agente_id
        WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
        LIMIT 1`,
      [taskId, taskId],
    )
    const task = taskRows[0]
    if (!task) return null

    const databaseTaskId = Number(task.id)

    // Determinar generation atual (max das subtarefas existentes)
    const [genRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(generation), 0) AS max_generation FROM subtarefas WHERE tarefa_id = ?`,
      [databaseTaskId],
    )
    const currentGeneration = Number(genRows[0]?.max_generation ?? 0)
    const nextGeneration = currentGeneration + 1

    // Se o expectedGeneration não bate com nextGeneration, algo está errado
    if (expectedGeneration !== nextGeneration) {
      console.warn(`[TaskAdjustmentConsumer] Generation mismatch: expected=${expectedGeneration}, calculated=${nextGeneration}`)
    }

    // Carregar subtarefas das generations anteriores
    const [subtaskRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT seq, titulo, status, generation, workspace_commit_sha
         FROM subtarefas
        WHERE tarefa_id = ? AND generation < ?
        ORDER BY generation ASC, seq ASC`,
      [databaseTaskId, nextGeneration],
    )

    return {
      databaseTaskId,
      taskId: String(task.external_id ?? task.id),
      title: String(task.titulo ?? ''),
      description: String(task.descricao ?? ''),
      taskType: String(task.tipo ?? 'desenvolvimento'),
      projectSlug: task.project_slug ? String(task.project_slug) : null,
      agentId: String(task.agent_id ?? ''),
      repoPath: String(task.repo_path ?? ''),
      currentGeneration,
      nextGeneration,
      previousSubtasks: subtaskRows.map(row => ({
        seq: Number(row.seq),
        titulo: String(row.titulo ?? ''),
        status: String(row.status ?? ''),
        generation: Number(row.generation ?? 1),
        commit_sha: row.workspace_commit_sha ? String(row.workspace_commit_sha) : null,
      })),
    }
  }

  private buildAdjustmentPrompt(context: AdjustmentTaskContext, adjustmentMessage: string): string {
    const previousSubtasksSummary = context.previousSubtasks.length > 0
      ? context.previousSubtasks.map(s =>
          `- [Gen ${s.generation}] Subtarefa ${s.seq}: ${s.titulo} (${s.status})${s.commit_sha ? ` — commit ${s.commit_sha.slice(0, 8)}` : ''}`
        ).join('\n')
      : 'Nenhuma subtarefa anterior.'

    return [
      `## AJUSTE INCREMENTAL — Generation ${context.nextGeneration}`,
      '',
      `Esta é a generation ${context.nextGeneration} da tarefa "${context.title}".`,
      `As generations anteriores já foram deployadas. Faça apenas mudanças incrementais para o ajuste solicitado.`,
      `NÃO refaça o que já foi feito nas generations anteriores.`,
      '',
      '### Descrição original da tarefa',
      context.description || 'N/A',
      '',
      '### Subtarefas das generations anteriores',
      previousSubtasksSummary,
      '',
      '### Mensagem de ajuste do usuário',
      adjustmentMessage,
      '',
      '### Instrução',
      `Crie subtarefas incrementais para resolver o ajuste solicitado na generation ${context.nextGeneration}.`,
      'Não refaça o que já foi feito. Foque apenas nas mudanças necessárias para atender ao ajuste.',
    ].join('\n')
  }

  private async persistAdjustmentSubtasks(databaseTaskId: number, generation: number, outcome: Extract<AnalysisOutcome, { kind: 'plan' }>): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const ids = new Map<number, number>()
      for (const subtask of outcome.subtasks) {
        const [result] = await connection.query<ResultSetHeader>(
          `INSERT INTO subtarefas
            (tarefa_id, seq, titulo, scope, acceptance_criteria, deliverables,
             requirements_covered, depends_on_subtask_ids, completion_kind, generation,
             status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())`,
          [
            databaseTaskId, subtask.seq, subtask.titulo, subtask.scope,
            JSON.stringify(subtask.acceptanceCriteria), JSON.stringify(subtask.deliverables),
            JSON.stringify(subtask.requirementsCovered), JSON.stringify([]),
            subtask.completionKind ?? 'code_change',
            generation,
          ],
        )
        ids.set(subtask.seq, result.insertId)
      }
      // Resolver dependências
      for (const subtask of outcome.subtasks) {
        const dependencyIds = subtask.dependsOn.map(seq => ids.get(seq)).filter((id): id is number => Boolean(id))
        if (dependencyIds.length > 0) {
          await connection.query(
            `UPDATE subtarefas SET depends_on_subtask_id = ?, depends_on_subtask_ids = ?
             WHERE tarefa_id = ? AND seq = ? AND generation = ?`,
            [dependencyIds[0], JSON.stringify(dependencyIds), databaseTaskId, subtask.seq, generation],
          )
        }
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async log(
    operationId: string,
    sequence: number,
    phase: 'received' | 'primitive' | 'completed' | 'failed' | 'rejected',
    outcome: 'executed' | 'succeeded' | 'failed' | 'skipped',
    message: QueueMessage,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.logger) return
    try {
      await this.logger.append({
        operationId, sequence, phase, outcome,
        messageId: message.messageId, messageType: message.type,
        correlationId: message.correlationId, causationId: message.causationId,
        taskId: message.taskId, ...extra,
      })
    } catch {
      // best-effort
    }
  }
}
