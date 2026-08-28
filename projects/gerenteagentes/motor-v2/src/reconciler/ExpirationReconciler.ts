/**
 * ExpirationReconciler - Reconciliador de expiração de locks
 * 
 * Etapa 9: Detecta locks expirados e retoma tarefas pendentes
 * Roda periodicamente (a cada 30s por padrão)
 */

import type { Db } from '@gerente-agentes/persistence'
import { resourceEventBus } from '../resources/ResourceEventBus.js'

export interface ExpirationReconcilerConfig {
  db: Db
  intervalMs?: number
  maxStalenessMs?: number
}

export class ExpirationReconciler {
  private db: Db
  private intervalMs: number
  private maxStalenessMs: number
  private timer: NodeJS.Timeout | null = null

  constructor(config: ExpirationReconcilerConfig) {
    this.db = config.db
    this.intervalMs = config.intervalMs ?? 30000 // 30s
    this.maxStalenessMs = config.maxStalenessMs ?? 120000 // 2 minutos
  }

  /**
   * Inicia reconciliador periódico
   */
  start(): void {
    if (this.timer) return

    console.log(`[ExpirationReconciler] Iniciando (intervalo: ${this.intervalMs}ms)`)

    this.timer = setInterval(async () => {
      await this.reconcile()
    }, this.intervalMs)

    // Primeira execução imediata
    this.reconcile().catch((error) => {
      console.error('[ExpirationReconciler] Erro na primeira execução:', error)
    })
  }

  /**
   * Para reconciliador
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log('[ExpirationReconciler] Parado')
    }
  }

  /**
   * Executa reconciliação
   */
  async reconcile(): Promise<void> {
    const now = new Date()
    const stalenessThreshold = new Date(now.getTime() - this.maxStalenessMs)

    try {
      // 1. Detecta locks expirados
      const expiredLeases = await this.db.query(
        `SELECT resource_key, execution_id, owner_id, fencing_token, expires_at
         FROM projeto_640.execution_resources
         WHERE expires_at < ?`,
        [now]
      )

      if (expiredLeases.rows.length > 0) {
        console.log(`[ExpirationReconciler] ${expiredLeases.rows.length} lock(s) expirado(s)`)

        for (const row of expiredLeases.rows) {
          await this.handleExpiredLease(row.resource_key as string, row.execution_id as string)
        }
      }

      // 2. Detecta tarefas órfãs (status running mas sem lock ativo)
      const orphanTasks = await this.db.query(
        `SELECT t.id, t.status
         FROM projeto_640.tarefas t
         WHERE t.status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM projeto_640.execution_resources r
             WHERE r.execution_id LIKE CONCAT('%', t.id, '%')
               AND r.expires_at > ?
           )`,
        [now]
      )

      if (orphanTasks.rows.length > 0) {
        console.log(`[ExpirationReconciler] ${orphanTasks.rows.length} tarefa(s) órfã(s)`)

        for (const row of orphanTasks.rows) {
          await this.handleOrphanTask(row.id as string)
        }
      }

      // 3. Detecta tasks paradas há muito tempo
      const stalePausedTasks = await this.db.query(
        `SELECT id, resource_wait_key, paused_at
         FROM projeto_640.tarefas
         WHERE status = 'paused'
           AND paused_at < ?`,
        [stalenessThreshold]
      )

      if (stalePausedTasks.rows.length > 0) {
        console.log(`[ExpirationReconciler] ${stalePausedTasks.rows.length} tarefa(s) pausada(s) há muito tempo`)

        for (const row of stalePausedTasks.rows) {
          await this.handleStalePausedTask(row.id as string, row.resource_wait_key as string)
        }
      }

    } catch (error) {
      console.error('[ExpirationReconciler] Erro durante reconciliação:', error)
    }
  }

  /**
   * Handler para lock expirado
   */
  private async handleExpiredLease(resourceKey: string, executionId: string): Promise<void> {
    console.log(`[ExpirationReconciler] Lock expirado: ${resourceKey} (exec: ${executionId})`)

    // Remove lock expirado
    await this.db.query(
      `DELETE FROM projeto_640.execution_resources
       WHERE resource_key = ? AND execution_id = ?`,
      [resourceKey, executionId]
    )

    // Publica evento de expiração
    resourceEventBus.publish({
      type: 'expired',
      resourceKey,
      executionId,
      timestamp: new Date(),
    })

    // Tenta retomar próxima tarefa da fila
    await this.processQueue(resourceKey)
  }

  /**
   * Handler para tarefa órfã
   */
  private async handleOrphanTask(taskId: string): Promise<void> {
    console.log(`[ExpirationReconciler] Tarefa órfã: ${taskId}`)

    // Marca tarefa como failed
    await this.db.query(
      `UPDATE projeto_640.tarefas
       SET status = 'failed',
           error_message = 'Lock expirado sem conclusão',
           updated_at = NOW()
       WHERE id = ?`,
      [taskId]
    )
  }

  /**
   * Handler para tarefa pausada há muito tempo
   */
  private async handleStalePausedTask(taskId: string, resourceWaitKey: string): Promise<void> {
    console.log(`[ExpirationReconciler] Tarefa pausada há muito tempo: ${taskId} (aguardando ${resourceWaitKey})`)

    // Cancela espera e retorna para planned
    await this.db.query(
      `UPDATE projeto_640.tarefas
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_position = NULL,
           paused_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [taskId]
    )
  }

  /**
   * Processa fila de espera para um recurso
   */
  private async processQueue(resourceKey: string): Promise<void> {
    // Busca próxima tarefa da fila
    const { rows } = await this.db.query(
      `SELECT execution_id, task_id, priority, requested_at
       FROM projeto_640.execution_resource_queue
       WHERE resource_key = ?
       ORDER BY priority DESC, requested_at ASC
       LIMIT 1`,
      [resourceKey]
    )

    if (rows.length === 0) {
      return
    }

    const next = rows[0]
    console.log(`[ExpirationReconciler] Próxima tarefa da fila: ${next.task_id}`)

    // Remove da fila (será processada pelo TaskCoordinator)
    await this.db.query(
      `DELETE FROM projeto_640.execution_resource_queue
       WHERE execution_id = ?`,
      [next.execution_id]
    )

    // Marca tarefa como ready para retry
    await this.db.query(
      `UPDATE projeto_640.tarefas
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_position = NULL,
           paused_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [next.task_id]
    )
  }
}
