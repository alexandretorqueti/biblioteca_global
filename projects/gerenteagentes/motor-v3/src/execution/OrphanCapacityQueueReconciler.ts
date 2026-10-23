import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

interface OrphanSessionRow extends RowDataPacket {
  session_id: number
  subtarefa_id: number
  session_key: string
  runtime_session_id: string | null
  subtask_status: string
  task_id: number
  task_external_id: string | null
}

interface StaleQueueRow extends RowDataPacket {
  id: number
  tarefa_id: number
  task_external_id: string | null
  source_message_id: string
  status: string
  terminal_status: string | null
  paused_at: Date | string | null
  has_active_block: number | string
  has_pending_subtask: number | string
  has_running_subtask: number | string
  has_pending_outbox: number | string
}

interface CooldownWaitRow extends RowDataPacket {
  tarefa_id: number
  projeto_id: number
  task_external_id: string | null
  project_slug: string | null
  wait_since: Date | string | null
  requested_at: Date | string | null
  retry_at: Date | string | null
  alert_at: Date | string | null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OrphanCapacityQueueReconcilerConfig {
  intervalMs?: number
  taskEvents?: TaskEventSink
  /**
   * Limite (ms) de indisponibilidade prolongada de modelo DEV antes de emitir
   * um único alerta durável. Padrão: 30 minutos.
   */
  cooldownAlertMs?: number
}

export interface OrphanCleanupSummary {
  orphanSessionsClosed: number
  staleQueueEntriesRemoved: number
  duplicateCommandsSuppressed: number
  cooldownWaitsResumed: number
  cooldownAlertsEmitted: number
}

/**
 * Reconcilia sessões DEV órfãs e entradas obsoletas na fila de capacidade.
 *
 * Complementa o `DevelopmentSessionRecoveryReconciler` (que cuida de sessões
 * com subtask `pending`/`running` órfãs de worker) e o `TaskExecutionReconciler`
 * (que reenfileira tarefas elegíveis). Este reconciliador fecha as pontas
 * soltas que nenhum dos dois cobre:
 *
 * 1. **Sessões órfãs por subtarefa terminal** — `motor_agent_sessions` ativa
 *    cuja subtarefa já está em estado terminal (`failed`, `verified`,
 *    `superseded`, `cancelled`). Sem essa limpeza, a sessão fica presa como
 *    `active` e conta contra os limites de capacidade.
 *
 * 2. **Fila de capacidade obsoleta** — `motor_execution_wait_queue` com
 *    entrada para tarefa terminal, pausada, bloqueada, sem subtarefa pendente
 *    elegível ou que já possui comando ativo no outbox. A entrada stale
 *    ocupa espaço na fila e pode liberar trabalho acima dos limites quando
 *    um `notifyCapacityReleased` a reanima.
 *
 * 3. **Deduplicação** — toda transição que gera comando (`TASK_READY_FOR_
 *    PROGRAMMING`) passa pela verificação de outbox/processing state, de
 *    forma que ciclos repetidos não produzam mensagens duplicadas.
 *
 * 4. **Espera por cooldown de modelo DEV** — reanima tarefas cuja espera tem
 *    motivo `model_cooldown` assim que um modelo volta a ficar elegível
 *    (retomada temporal: nenhuma liberação de vaga dispara esse gatilho) e
 *    emite um único alerta durável quando a indisponibilidade excede o limite
 *    configurado, sem transformar a espera temporária em falha.
 */
export class OrphanCapacityQueueReconciler {
  private readonly intervalMs: number
  private readonly cooldownAlertMs: number
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: Pool,
    private readonly config: OrphanCapacityQueueReconcilerConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 60_000
    this.cooldownAlertMs = config.cooldownAlertMs ?? 1_800_000
  }

  start(): void {
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async reconcile(): Promise<OrphanCleanupSummary> {
    const summary: OrphanCleanupSummary = {
      orphanSessionsClosed: 0,
      staleQueueEntriesRemoved: 0,
      duplicateCommandsSuppressed: 0,
      cooldownWaitsResumed: 0,
      cooldownAlertsEmitted: 0,
    }
    try {
      summary.orphanSessionsClosed = await this.closeOrphanedTerminalSessions()
      const queueResult = await this.cleanStaleCapacityQueue()
      summary.staleQueueEntriesRemoved = queueResult.removed
      summary.duplicateCommandsSuppressed = queueResult.suppressed
      const cooldownResult = await this.resumeDevModelCooldownWaits()
      summary.cooldownWaitsResumed = cooldownResult.resumed
      summary.cooldownAlertsEmitted = cooldownResult.alerts
    } catch (error) {
      console.error('[Motor v3] Falha no ciclo de reconciliação de órfãos e fila:', this.errorMessage(error))
    }
    return summary
  }

  // ---------------------------------------------------------------------------
  // 1. Sessões órfãs por subtarefa terminal
  // ---------------------------------------------------------------------------

  /**
   * Fecha sessões ativas cuja subtarefa já atingiu estado terminal.
   *
   * A transição é idempotente: o `UPDATE … WHERE status='active'` só afeta
   * linhas ainda não fechadas, então ciclos repetidos não re-fecham sessões
   * já tratadas. O `tarefa_contextos_execucao` correspondente também é
   * fechado para que o `DevelopmentSessionRecoveryReconciler` deixe de
   * enxergar a sessão no próximo ciclo.
   */
  private async closeOrphanedTerminalSessions(): Promise<number> {
    const [rows] = await this.pool.query<OrphanSessionRow[]>(`
      SELECT mas.id AS session_id, mas.subtarefa_id, mas.session_key,
             mas.runtime_session_id, s.status AS subtask_status,
             s.tarefa_id, t.external_id AS task_external_id
        FROM motor_agent_sessions mas
        INNER JOIN subtarefas s ON s.id = mas.subtarefa_id
        INNER JOIN tarefas t ON t.id = s.tarefa_id
       WHERE mas.status = 'active'
         AND s.status IN ('verified', 'superseded', 'cancelled', 'failed')
         AND NOT EXISTS (
           SELECT 1 FROM motor_agent_sessions mas2
            WHERE mas2.subtarefa_id = mas.subtarefa_id
              AND mas2.status = 'active'
              AND mas2.id != mas.id
              AND mas2.last_activity_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         )
    `)
    let closed = 0
    for (const row of rows) {
      try {
        const closeReason = `orphan_subtask_${row.subtask_status}`
        const [result] = await this.pool.query<RowDataPacket[]>(
          `UPDATE motor_agent_sessions
              SET status = 'failed', close_reason = ?, closed_at = NOW(), last_activity_at = NOW()
            WHERE id = ? AND status = 'active'`,
          [closeReason, row.session_id],
        )
        const affected = Number((result as any).affectedRows ?? 0)
        if (affected > 0) {
          // Fecha também o contexto de execução correspondente.
          await this.pool.query(
            `UPDATE tarefa_contextos_execucao
                SET estado = 'closed', closed_at = NOW(), updated_at = NOW()
              WHERE subtarefa_id = ? AND sessao_chave = ? AND estado != 'closed'`,
            [row.subtarefa_id, row.session_key],
          )
          const taskId = String(row.task_external_id ?? row.tarefa_id)
          await this.record(taskId, 'orphan_session_closed', {
            sessionId: row.session_id,
            subtaskId: row.subtarefa_id,
            subtaskStatus: row.subtask_status,
            reason: closeReason,
          })
          closed++
        }
      } catch (error) {
        console.error(`[Motor v3] Falha ao fechar sessão órfã ${row.session_id}:`, this.errorMessage(error))
      }
    }
    return closed
  }

  // ---------------------------------------------------------------------------
  // 2. Fila de capacidade obsoleta
  // ---------------------------------------------------------------------------

  /**
   * Remove entradas obsoletas de `motor_execution_wait_queue`.
   *
   * Uma entrada é obsoleta quando qualquer uma das condições é verdadeira:
   * - A tarefa tem `terminal_status` preenchido (completed/failed/cancelled).
   * - A tarefa está pausada (`paused_at IS NOT NULL`).
   * - A tarefa possui bloqueio ativo (`bloqueios.resolved_at IS NULL`).
   * - Não existe subtarefa `pending` elegível (todas verificadas, em
   *   execução, ou com dependência não resolvida).
   * - Já existe comando `TASK_READY_FOR_PROGRAMMING` pendente no outbox
   *   (nesse caso, a entrada é removida mas nenhum comando novo é criado,
   *   pois o existente já cobrirá a demanda).
   *
   * A remoção é direta (`DELETE WHERE tarefa_id = ?`) e, por isso,
   * idempotente — se a entrada já foi removida por outro ciclo ou por uma
   * reserva de subtarefa, o DELETE simplesmente não afeta linhas.
   */
  private async cleanStaleCapacityQueue(): Promise<{ removed: number; suppressed: number }> {
    const [rows] = await this.pool.query<StaleQueueRow[]>(`
      SELECT q.id, q.tarefa_id,
             COALESCE(t.external_id, CAST(t.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci) AS task_external_id,
             q.source_message_id,
             q.status,
             f.terminal_status,
             t.paused_at,
             EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS has_active_block,
             (SELECT COUNT(*) FROM subtarefas s
               WHERE s.tarefa_id = t.id AND s.status = 'pending'
                 AND s.generation = (SELECT MAX(s2.generation) FROM subtarefas s2 WHERE s2.tarefa_id = s.tarefa_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM subtarefas active WHERE active.tarefa_id = s.tarefa_id
                     AND active.status IN ('running', 'delivered', 'verifying')
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM subtarefas prev WHERE prev.tarefa_id = s.tarefa_id
                     AND prev.generation = s.generation AND prev.seq < s.seq
                     AND prev.status NOT IN ('verified', 'superseded')
                     AND prev.id != COALESCE(s.correction_for_subtask_id, -1)
                 )
             ) AS has_pending_subtask,
             (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status = 'running') AS has_running_subtask,
             (SELECT COUNT(*) FROM motor_outbox o
               WHERE (o.task_id COLLATE utf8mb4_unicode_ci = COALESCE(t.external_id, CAST(t.id AS CHAR)) COLLATE utf8mb4_unicode_ci
                   OR o.task_id COLLATE utf8mb4_unicode_ci = CAST(t.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci)
                 AND o.type = 'TASK_READY_FOR_PROGRAMMING'
                 AND (o.status = 'pending'
                   OR EXISTS (
                     SELECT 1 FROM motor_message_processing_state mps
                      WHERE mps.message_id COLLATE utf8mb4_unicode_ci = o.message_id COLLATE utf8mb4_unicode_ci
                        AND mps.status = 'processing'
                   ))
             ) AS has_pending_outbox
        FROM motor_execution_wait_queue q
        INNER JOIN tarefas t ON t.id = q.tarefa_id
        LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       ORDER BY q.tarefa_id ASC
    `)

    let removed = 0
    let suppressed = 0
    for (const row of rows) {
      const dominated = await this.isStale(row)
      if (!dominated.stale) continue
      try {
        const [result] = await this.pool.query<RowDataPacket[]>(
          'DELETE FROM motor_execution_wait_queue WHERE tarefa_id = ?',
          [row.tarefa_id],
        )
        const affected = Number((result as any).affectedRows ?? 0)
        if (affected > 0) {
          removed++
          const taskId = String(row.task_external_id ?? row.tarefa_id)
          await this.record(taskId, 'stale_capacity_wait_removed', {
            tarefaId: row.tarefa_id,
            sourceMessageId: row.source_message_id,
            queueStatus: row.status,
            dominatedReason: dominated.reason,
          })
        }
        // Se a tarefa ainda tem subtarefa elegível e não tem comando
        // pendente, o `TaskExecutionReconciler` já publicará o comando
        // no próximo ciclo — não precisamos duplicar aqui. Se já tem
        // comando pendente, apenas removemos a entrada da fila.
        if (dominated.reason === 'duplicate_command') suppressed++
      } catch (error) {
        console.error(`[Motor v3] Falha ao limpar fila de capacidade para tarefa ${row.tarefa_id}:`, this.errorMessage(error))
      }
    }
    return { removed, suppressed }
  }

  /**
   * Classifica uma entrada da fila como obsoleta.
   * Retorna `{ stale: false }` quando a entrada ainda é válida.
   */
  private async isStale(row: StaleQueueRow): Promise<{ stale: boolean; reason?: string }> {
    // Terminal
    if (row.terminal_status && ['completed', 'failed', 'cancelled'].includes(String(row.terminal_status))) {
      return { stale: true, reason: 'terminal_task' }
    }
    // Pausada
    if (row.paused_at) {
      return { stale: true, reason: 'paused_task' }
    }
    // Bloqueada
    if (Number(row.has_active_block) > 0) {
      return { stale: true, reason: 'blocked_task' }
    }
    // Sem subtarefa pending elegível e sem subtarefa running
    if (Number(row.has_pending_subtask) === 0 && Number(row.has_running_subtask) === 0) {
      return { stale: true, reason: 'no_eligible_subtask' }
    }
    // Já possui comando pendente no outbox — a entrada da fila é redundante.
    if (Number(row.has_pending_outbox) > 0) {
      return { stale: true, reason: 'duplicate_command' }
    }
    return { stale: false }
  }

  // ---------------------------------------------------------------------------
  // 3. Espera de capacidade por cooldown de modelo DEV
  // ---------------------------------------------------------------------------

  /**
   * Retoma tarefas em espera por capacidade de modelo DEV assim que ao menos
   * um modelo habilitado sai do cooldown, e emite um único alerta durável
   * quando a indisponibilidade excede o limite configurado.
   *
   * A retomada NÃO transiciona a subtarefa para running: ela apenas reemite o
   * gatilho `TASK_READY_FOR_PROGRAMMING` (deduplicado contra outbox/processing
   * state), e o claim atômico em `reserveNextSubtask` continua sendo a única
   * transição para running — logo não existe execução concorrente. Se o
   * cooldown persistir na re-reserva, a espera é gravada novamente com novo
   * prazo (uma única entrada por tarefa, garantida pelo UNIQUE de
   * `motor_execution_wait_queue`).
   */
  private async resumeDevModelCooldownWaits(): Promise<{ resumed: number; alerts: number }> {
    const [rows] = await this.pool.query<CooldownWaitRow[]>(`
      SELECT q.tarefa_id, q.projeto_id, q.requested_at,
             COALESCE(t.external_id, CAST(t.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci) AS task_external_id,
             pc.slug AS project_slug,
             f.capacity_wait_since AS wait_since,
             f.capacity_wait_retry_at AS retry_at,
             f.capacity_wait_alert_at AS alert_at
        FROM motor_execution_wait_queue q
        INNER JOIN tarefas t ON t.id = q.tarefa_id
        INNER JOIN task_runtime_facts f ON f.tarefa_id = t.id
        LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
       WHERE q.status = 'waiting'
         AND f.capacity_wait_reason_code = 'model_cooldown'
         AND f.terminal_status IS NULL
         AND t.paused_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL)
       ORDER BY q.requested_at ASC, q.id ASC
    `)
    let resumed = 0
    let alerts = 0
    for (const row of rows) {
      try {
        const slug = String(row.project_slug ?? '')
        const eligible = slug ? await this.hasEligibleDevelopmentModel(slug) : false
        if (eligible) {
          if (await this.requeueCooldownWait(row)) resumed++
          continue
        }
        if (slug) await this.refreshCooldownRetryAt(row, slug)
        if (await this.maybeAlertProlongedCooldownWait(row)) alerts++
      } catch (error) {
        console.error(`[Motor v3] Falha ao retomar espera de cooldown da tarefa ${row.tarefa_id}:`, this.errorMessage(error))
      }
    }
    return { resumed, alerts }
  }

  /** Existe ao menos um modelo DEV habilitado fora de cooldown para o projeto? */
  private async hasEligibleDevelopmentModel(projectSlug: string): Promise<boolean> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { available: number | string }>>(`
      SELECT EXISTS(
        SELECT 1 FROM project_model_selection sel
         WHERE sel.project_slug = ? AND sel.tipo = 'DEV' AND sel.enabled = 1
           AND NOT EXISTS (
             SELECT 1 FROM motor_model_cooldown cooldown
              WHERE cooldown.model COLLATE utf8mb4_unicode_ci = sel.model COLLATE utf8mb4_unicode_ci
                AND cooldown.until > NOW()
           )
      ) AS available
    `, [projectSlug])
    return Number(rows[0]?.available ?? 0) !== 0
  }

  /**
   * Reemite o gatilho de programação em transação, deduplicando contra o
   * outbox e o estado de processamento. Idempotente: ciclos repetidos com o
   * comando ainda pendente não produzem nova mensagem.
   */
  private async requeueCooldownWait(row: CooldownWaitRow): Promise<boolean> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [taskRows] = await connection.query<Array<RowDataPacket & {
        id: number; external_id: string | null; paused_at: unknown; terminal_status: unknown
      }>>(`
        SELECT t.id, t.external_id, t.paused_at, f.terminal_status
          FROM tarefas t
          LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
         WHERE t.id = ?
         LIMIT 1 FOR UPDATE
      `, [row.tarefa_id])
      const task = taskRows[0]
      if (!task || task.paused_at || task.terminal_status) {
        await connection.rollback()
        return false
      }
      if (await this.hasUnfinishedReadyCommand(connection, task)) {
        await connection.rollback()
        return false
      }
      const taskId = String(task.external_id ?? task.id)
      const message = createQueueMessage({
        type: 'TASK_READY_FOR_PROGRAMMING',
        taskId,
        executionId: `exec-cooldown-${task.id}-${Date.now()}`,
        payload: { reason: 'dev_model_cooldown_expired', recovered: true },
      })
      await insertOutboxMessage(connection, message)
      await connection.query(
        `UPDATE motor_execution_wait_queue
            SET wake_count = wake_count + 1, last_woken_at = NOW()
          WHERE tarefa_id = ?`,
        [row.tarefa_id],
      )
      await connection.commit()
      await this.record(taskId, 'dev_model_cooldown_resumed', {
        reasonCode: 'model_cooldown',
        messageId: message.messageId,
        queueStatus: row.status,
      })
      return true
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async hasUnfinishedReadyCommand(
    connection: PoolConnection,
    task: { id: number; external_id: string | null },
  ): Promise<boolean> {
    const [rows] = await connection.query<Array<RowDataPacket & { total: number | string }>>(`
      SELECT COUNT(*) AS total
        FROM motor_outbox o
       WHERE o.type = 'TASK_READY_FOR_PROGRAMMING'
         AND (o.task_id COLLATE utf8mb4_unicode_ci = COALESCE(?, CAST(? AS CHAR CHARACTER SET utf8mb4)) COLLATE utf8mb4_unicode_ci
           OR o.task_id COLLATE utf8mb4_unicode_ci = CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci)
         AND (
           o.status = 'pending'
           OR EXISTS (
             SELECT 1 FROM motor_message_processing_state mps
              WHERE mps.message_id COLLATE utf8mb4_unicode_ci = o.message_id COLLATE utf8mb4_unicode_ci
                AND mps.status = 'processing'
           )
         )
    `, [task.external_id, task.id, task.id])
    return Number(rows[0]?.total ?? 0) > 0
  }

  /** Mantém o prazo previsto de nova elegibilidade sincronizado com o cooldown vigente. */
  private async refreshCooldownRetryAt(row: CooldownWaitRow, projectSlug: string): Promise<void> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { next_available_at: Date | string | null }>>(`
      SELECT MIN(cooldown.until) AS next_available_at
        FROM motor_model_cooldown cooldown
       WHERE cooldown.until > NOW()
         AND EXISTS (
           SELECT 1 FROM project_model_selection sel
            WHERE sel.project_slug = ? AND sel.tipo = 'DEV' AND sel.enabled = 1
              AND sel.model COLLATE utf8mb4_unicode_ci = cooldown.model COLLATE utf8mb4_unicode_ci
         )
    `, [projectSlug])
    const next = rows[0]?.next_available_at ? new Date(rows[0].next_available_at) : null
    await this.pool.query(
      `UPDATE task_runtime_facts
          SET capacity_wait_retry_at = ?, updated_at = NOW()
        WHERE tarefa_id = ?
          AND capacity_wait_reason_code = 'model_cooldown'
          AND NOT (capacity_wait_retry_at <=> ?)`,
      [next, row.tarefa_id, next],
    )
  }

  /**
   * Alerta único e durável para indisponibilidade prolongada: o controle fica
   * em `capacity_wait_alert_at` e o UPDATE condicional (`IS NULL`) torna a
   * emissão idempotente mesmo entre instâncias/ciclos concorrentes.
   */
  private async maybeAlertProlongedCooldownWait(row: CooldownWaitRow): Promise<boolean> {
    if (row.alert_at) return false
    const since = row.wait_since ?? row.requested_at
    if (!since) return false
    const waitedMs = Date.now() - new Date(since).getTime()
    if (!Number.isFinite(waitedMs) || waitedMs < this.cooldownAlertMs) return false
    const [result] = await this.pool.query<RowDataPacket[]>(
      `UPDATE task_runtime_facts
          SET capacity_wait_alert_at = NOW(), updated_at = NOW()
        WHERE tarefa_id = ?
          AND capacity_wait_reason_code = 'model_cooldown'
          AND capacity_wait_alert_at IS NULL`,
      [row.tarefa_id],
    )
    if (Number((result as { affectedRows?: number | string }).affectedRows ?? 0) === 0) return false
    const taskId = String(row.task_external_id ?? row.tarefa_id)
    const payload = {
      reasonCode: 'model_cooldown',
      waitedMs,
      limitMs: this.cooldownAlertMs,
      retryAt: row.retry_at ? new Date(row.retry_at).toISOString() : null,
    }
    console.warn(`[Motor v3] Tarefa ${taskId} aguardando modelo DEV há ${Math.round(waitedMs / 60_000)} min (limite ${Math.round(this.cooldownAlertMs / 60_000)} min); próxima elegibilidade prevista: ${payload.retryAt ?? 'desconhecida'}`)
    await this.record(taskId, 'dev_model_capacity_alert', payload)
    return true
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async record(taskId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.config.taskEvents?.record(taskId, event, 'motor', payload) }
    catch (error) { console.warn(`[Motor v3] Falha ao registrar ${event}:`, this.errorMessage(error)) }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
