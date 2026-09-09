/**
 * ExpirationReconciler - Detecta locks expirados e retoma tarefas
 */

import type { Db } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { resourceEventBus } from '../resources/ResourceEventBus.js'
import { createLogger, describeError } from '../shared/logger.js'
import { AGENT_RUN_FAILED_WITHOUT_REPLY } from '../policies/NoReplyFailurePolicy.js'
import { getConfigNumber } from '../config/MotorConfigReader.js'
import type { ConsoleAgentRuntimeDriver } from '../runtime/ConsoleAgentRuntimeDriver.js'

export interface ExpirationReconcilerConfig {
  db: Db
  intervalMs?: number
  maxStalenessMs?: number
  consoleDriver?: ConsoleAgentRuntimeDriver
  onLeaseExpired?: (resourceKey: ResourceKey, executionId: string) => void | Promise<void>
}

export class ExpirationReconciler {
  private logger = createLogger('ExpirationReconciler')
  private db: Db
  private intervalMs: number
  private maxStalenessMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private onLeaseExpired?: ExpirationReconcilerConfig['onLeaseExpired']
  private consoleDriver?: ConsoleAgentRuntimeDriver

  constructor(config: ExpirationReconcilerConfig) {
    this.db = config.db
    this.intervalMs = config.intervalMs ?? 30000
    this.maxStalenessMs = config.maxStalenessMs ?? 120000
    this.onLeaseExpired = config.onLeaseExpired
    this.consoleDriver = config.consoleDriver
  }

  start(): void {
    if (this.timer) return
    this.logger.info(`Iniciando (${this.intervalMs}ms)`)
    this.timer = setInterval(() => { this.reconcile().catch((error) => this.logger.error('Erro no reconcile: ' + describeError(error))) }, this.intervalMs)
    this.reconcile().catch((error) => this.logger.error('Erro no reconcile: ' + describeError(error)))
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async reconcile(): Promise<void> {
    const now = new Date()
    const expired = await this.db.query(
      `SELECT resource_key, execution_id FROM execution_resources WHERE expires_at < ?`,
      [now]
    )

    for (const row of expired.rows) {
      const key = String(row.resource_key!) as ResourceKey
      const execId = String(row.execution_id!)
      this.logger.info(`Lock expirado: ${key}`, { executionId: execId })

      await this.db.query(
        `DELETE FROM execution_resources WHERE resource_key = ? AND execution_id = ?`,
        [key, execId]
      )

      resourceEventBus.publish({ type: 'expired', resourceKey: key, executionId: execId, timestamp: now })
      await this.onLeaseExpired?.(key, execId)
    }

    await this.repairVerifiedNoReplySubtasks()

    const orphans = await this.db.query(
      `SELECT t.id, t.external_id,
              EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) AS has_subtasks
       FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE f.terminal_status IS NULL
         AND (f.analysis_started_at IS NOT NULL OR EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status IN ('running', 'delivered', 'verifying')))
         AND NOT EXISTS (
           SELECT 1 FROM execution_resources r
           WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id)
             AND r.expires_at > ?
         )`,
      [now]
    )

    for (const row of orphans.rows) {
      const taskId = String(row.id!)
      this.logger.info(`Tarefa órfã: ${taskId}`, { taskId })
      const hasSubtasks = Number(row.has_subtasks ?? 0) === 1
      if (hasSubtasks) {
        await this.db.query(
          `UPDATE subtarefas SET status = 'pending', updated_at = NOW()
           WHERE tarefa_id = ? AND status IN ('running', 'delivered', 'verifying', 'rejected')`,
          [taskId],
        )
      }
    }

    await this.repairOrphanedRunningSubtasks(now)
    await this.recoverOrphanedAnalysis(now)
  }

  /**
   * Recupera tarefas que ficaram presas em analyzing após falha/expiração do agente.
   */
  private async recoverOrphanedAnalysis(now: Date): Promise<void> {
    const orphanTimeoutMs = getConfigNumber('motor.orphan_analysis_timeout_ms')
    const cutoff = new Date(now.getTime() - orphanTimeoutMs)
    
    const staleAnalysis = await this.db.query(
      `SELECT t.id, t.external_id, f.analysis_started_at
       FROM tarefas t
       INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE f.analysis_started_at IS NOT NULL
         AND f.terminal_status IS NULL
         AND f.analysis_started_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM execution_resources r
           WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id)
             AND r.expires_at > ?
         )`,
      [cutoff, now]
    )

    for (const row of staleAnalysis.rows) {
      const taskId = String(row.id!)
      const externalId = String(row.external_id!)
      const analysisStartedAt = row.analysis_started_at as Date
      
      if (this.consoleDriver) {
        try {
          const hasActiveSession = await this.checkForActiveAnalysisSession(taskId, externalId)
          if (hasActiveSession) {
            this.logger.info(`Tarefa ${taskId} tem sessão de análise ativa no OpenClaw; não recuperando`, { taskId, externalId })
            continue
          }
        } catch (error) {
          this.logger.warn(`Falha ao consultar OpenClaw para tarefa ${taskId}; recuperando mesmo assim`, { taskId, error: String(error) })
        }
      }
      
      const stuckDurationMs = now.getTime() - analysisStartedAt.getTime()
      const stuckMinutes = Math.round(stuckDurationMs / 60000)
      
      await this.db.query(
        `UPDATE task_runtime_facts SET analysis_started_at = NULL WHERE tarefa_id = ?`,
        [taskId]
      )
      
      this.logger.warn(
        `Tarefa em análise recuperada: ${taskId} (sem atividade há ${stuckMinutes}min)`,
        { taskId, externalId, stuckMinutes }
      )
    }
  }

  /**
   * Verifica se há sessão de análise ativa para a tarefa no OpenClaw.
   */
  private async checkForActiveAnalysisSession(taskId: string, externalId: string): Promise<boolean> {
    if (!this.consoleDriver) return false
    
    try {
      const allSessions = await this.consoleDriver.listSessions('')
      const analysisSessions = allSessions.filter(s => 
        s.key.includes('analysis-') && 
        (s.key.includes(`-${taskId}-`) || s.key.includes(`-${externalId}-`))
      )
      
      for (const session of analysisSessions) {
        const agentId = session.agentId || 'programador-senior'
        const desc = await this.consoleDriver.describeSession(session.key, agentId)
        const active = 
          desc.hasActiveRun === true ||
          desc.state === 'busy' || desc.state === 'running' || desc.state === 'streaming' ||
          desc.status === 'busy' || desc.status === 'running' || desc.status === 'streaming'
        
        if (active) return true
      }
      
      return false
    } catch (error) {
      this.logger.warn(`Falha ao verificar sessões ativas: ${String(error)}`)
      return false
    }
  }

  private async repairOrphanedRunningSubtasks(now: Date): Promise<void> {
    const stale = await this.db.query(
      `SELECT s.id AS subtask_id, s.tarefa_id, t.external_id
       FROM subtarefas s
       INNER JOIN tarefas t ON t.id = s.tarefa_id
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE s.status = 'running'
         AND f.terminal_status IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM execution_resources r
           WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id)
             AND r.expires_at > ?
         )`,
      [now],
    )
    for (const row of stale.rows) {
      const subtaskId = Number(row.subtask_id)
      const taskId = Number(row.tarefa_id)
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE subtarefas SET status = 'pending', updated_at = NOW(),
             resultado = CONCAT(COALESCE(resultado, ''), '\n[reconciliado] Worker/lease expirado; subtarefa devolvida à fila.')
           WHERE id = ? AND status = 'running'`,
          [subtaskId],
        )
      })
      this.logger.warn(`Subtarefa órfã reconciliada: ${subtaskId}`, { taskId: String(row.external_id) })
    }
  }

  private async repairVerifiedNoReplySubtasks(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const affected = await tx.query(
        `SELECT DISTINCT s.tarefa_id FROM subtarefas s
         WHERE s.status = 'verified' AND TRIM(COALESCE(s.resultado, '')) = ?`,
        [AGENT_RUN_FAILED_WITHOUT_REPLY],
      )
      if (affected.rows.length === 0) return

      await tx.query(
        `UPDATE subtarefas SET status = 'pending', finalizada_em = NULL, updated_at = NOW()
         WHERE status = 'verified' AND TRIM(COALESCE(resultado, '')) = ?`,
        [AGENT_RUN_FAILED_WITHOUT_REPLY],
      )
      this.logger.warn(`Reparadas ${affected.rows.length} tarefa(s) com subtarefa verified sem resposta`)
    })
  }
}
