/**
 * MotorAPI - Endpoints REST para o Motor v2
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { TaskCoordinator } from '../coordinator/TaskCoordinator.js'
import { createLogger } from '../shared/logger.js'
import type { Db } from '../shared/types/infrastructure.js'
import { AdvancementMetricsRepository, type MetricsFilter, type AdvancementMetricsResult } from '../metrics/AdvancementMetrics.js'

export interface MotorAPIConfig {
  port: number
  coordinator: TaskCoordinator
  db?: Db
}

export class MotorAPI {
  private logger = createLogger('MotorAPI')
  private server: Server | null = null
  private coordinator: TaskCoordinator
  private port: number
  private db?: Db

  constructor(config: MotorAPIConfig) {
    this.port = config.port
    this.coordinator = config.coordinator
    this.db = config.db
    this.server = createServer((req, res) => { this.handleRequest(req, res) })
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.listen(this.port, () => {
        this.logger.info(`Porta ${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return }
      this.server.close((err) => { if (err) reject(err); else resolve() })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    // Extrai taskId de /api/motor/task/:id/...
    const taskMatch = path.match(/^\/api\/motor\/task\/([^/]+)(?:\/(.+))?$/)
    const taskId = taskMatch?.[1]
    const taskAction = taskMatch?.[2]

    // Extrai projectKey e tipo de /api/model-selection/:projectKey/:tipo
    const modelSelectionMatch = path.match(/^\/api\/model-selection\/([^/]+)\/([^/]+)$/)
    const projectKey = modelSelectionMatch?.[1]
    const tipo = modelSelectionMatch?.[2]

    try {
      if (req.method === 'GET' && path === '/api/motor/health') {
        this.json(res, 200, { ok: true, runtime: 'motor-v2', timestamp: new Date().toISOString() })
      } else if (req.method === 'GET' && path === '/api/motor/stats') {
        this.json(res, 200, this.coordinator.getStats())
      } else if (req.method === 'POST' && path === '/api/motor/pump') {
        this.coordinator.pump()
          .then(() => this.json(res, 200, { ok: true }))
          .catch((error: unknown) => this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Pump failed' }))
      }
      // Model selection endpoints
      else if (req.method === 'GET' && projectKey && tipo) {
        this.handleGetModelSelection(res, projectKey, tipo)
      } else if (req.method === 'PUT' && projectKey && tipo) {
        this.handleSaveModelSelection(req, res, projectKey, tipo)
      } else if (req.method === 'GET' && path === '/api/modelos-console') {
        this.handleListModelsConsole(res)
      } else if (req.method === 'GET' && path === '/api/motor/tasks/by-status') {
        this.handleGetTasksByStatus(res, url.searchParams.get('since'))
      }
      // Metrics endpoints
      else if (req.method === 'GET' && path === '/api/motor/metrics') {
        this.handleGetMetrics(res, url)
      } else if (req.method === 'GET' && path === '/api/motor/metrics/tasks') {
        this.handleGetMetricsTasks(res, url)
      }
      // Task endpoints
      else if (req.method === 'GET' && taskId && !taskAction) {
        this.handleGetTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'enqueue') {
        this.handleEnqueueTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'pause') {
        this.handlePauseTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'resume') {
        this.handleResumeTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'cancel') {
        this.handleCancelTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'deploy') {
        this.handleDeployTask(res, taskId)
      } else if (req.method === 'POST' && taskId && taskAction === 'clarification') {
        this.handleClarification(req, res, taskId)
      } else {
        this.json(res, 404, { ok: false, error: 'Not found' })
      }
    } catch (error) {
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  private async handleGetTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      const task = await this.coordinator.getTaskWithSubtasks(taskId)
      if (!task) {
        this.json(res, 404, { ok: false, error: 'Task not found' })
        return
      }
      this.json(res, 200, task)
    } catch (error) {
      this.logger.error('Failed to get task', { error, taskId })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  private async handleGetTasksByStatus(res: ServerResponse, since: string | null): Promise<void> {
    try {
      const result = await this.coordinator.getTasksByStatus(since ?? undefined)
      this.json(res, 200, result)
    } catch (error) {
      this.logger.error('Failed to get tasks by status', { error })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  private async handleEnqueueTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      const result = await this.coordinator.enqueueTask(taskId)
      this.json(res, 200, { ok: true, executionId: result.executionId })
    } catch (error) {
      this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Enqueue failed' })
    }
  }

  private async handlePauseTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      await this.coordinator.pauseTask(taskId)
      this.json(res, 200, { ok: true })
    } catch (error) {
      this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Pause failed' })
    }
  }

  private async handleResumeTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      await this.coordinator.resumeTask(taskId)
      this.json(res, 200, { ok: true })
    } catch (error) {
      this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Resume failed' })
    }
  }

  private async handleCancelTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      await this.coordinator.cancelTask(taskId)
      this.json(res, 200, { ok: true })
    } catch (error) {
      this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Cancel failed' })
    }
  }

  private async handleDeployTask(res: ServerResponse, taskId: string): Promise<void> {
    try {
      await this.coordinator.deployTask(taskId)
      this.json(res, 202, { ok: true, message: 'Deploy iniciado' })
    } catch (error) {
      this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Deploy failed' })
    }
  }

  /**
   * Resposta de clarificação: grava no chat da tarefa e devolve a tarefa
   * para análise. Body: { texto: string, jaPersistida?: boolean } —
   * `jaPersistida=true` quando o chamador (ex.: chat da biblioteca) já gravou
   * a mensagem e quer apenas retomar a análise.
   */
  private handleClarification(req: IncomingMessage, res: ServerResponse, taskId: string): void {
    this.readBody(req)
      .then((body) => {
        const texto = typeof body?.texto === 'string' ? body.texto : ''
        const jaPersistida = body?.jaPersistida === true
        return this.coordinator.answerClarification(taskId, texto, { jaPersistida })
      })
      .then(() => this.json(res, 200, { ok: true }))
      .catch((error) => {
        this.json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Clarification failed' })
      })
  }

  // ===========================================================================
  // METRICS ENDPOINTS
  // ===========================================================================

  /**
   * GET /api/motor/metrics — KPIs consolidados de avanço do Motor.
   *
   * Query params:
   * - projectId: number (opcional) — filtra por projeto
   * - taskId: number (opcional) — filtra por tarefa
   * - from: ISO-8601 date (opcional) — início do período
   * - to: ISO-8601 date (opcional) — fim do período
   *
   * Retorna todos os indicadores de avanço aceito, progresso operacional,
   * taxas de aprovação/retrabalho/bloqueio, lead time, tempo bloqueado,
   * sucesso de gates, confiabilidade pós-deploy e data_quality.
   */
  private async handleGetMetrics(res: ServerResponse, url: URL): Promise<void> {
    if (!this.db) {
      this.json(res, 503, { ok: false, error: 'Database not available' })
      return
    }

    try {
      const filter = this.parseMetricsFilter(url)
      const repo = new AdvancementMetricsRepository(this.db)
      const result = await repo.compute(filter)

      this.json(res, 200, {
        ok: true,
        ...this.formatMetricsResponse(result),
      })
    } catch (error) {
      this.logger.error('Failed to compute metrics', { error })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  /**
   * GET /api/motor/metrics/tasks — lista tarefas com resumo de métricas por tarefa.
   *
   * Query params:
   * - projectId: number (opcional) — filtra por projeto
   * - from: ISO-8601 date (opcional) — início do período
   * - to: ISO-8601 date (opcional) — fim do período
   * - page: number (default 1) — página
   * - pageSize: number (default 20, max 100) — itens por página
   *
   * Retorna lista de tarefas com contagem de subtarefas por status,
   * avanço aceito e progresso operacional por tarefa.
   */
  private async handleGetMetricsTasks(res: ServerResponse, url: URL): Promise<void> {
    if (!this.db) {
      this.json(res, 503, { ok: false, error: 'Database not available' })
      return
    }

    try {
      const projectId = url.searchParams.get('projectId')
        ? Number(url.searchParams.get('projectId'))
        : undefined
      const from = url.searchParams.get('from')
        ? new Date(url.searchParams.get('from')!)
        : undefined
      const to = url.searchParams.get('to')
        ? new Date(url.searchParams.get('to')!)
        : undefined
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? '20')))
      const offset = (page - 1) * pageSize

      const conditions: string[] = []
      const params: unknown[] = []

      if (projectId != null && !Number.isNaN(projectId)) {
        conditions.push('t.projeto_id = ?')
        params.push(projectId)
      }
      if (from != null && !Number.isNaN(from.getTime())) {
        conditions.push('t.created_at >= ?')
        params.push(from)
      }
      if (to != null && !Number.isNaN(to.getTime())) {
        conditions.push('t.created_at <= ?')
        params.push(to)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Count total
      const countResult = await this.db.query(
        `SELECT COUNT(*) AS total FROM tarefas t ${where}`,
        params,
      )
      const total = Number(countResult.rows[0]?.total ?? 0)

      // Fetch tasks with subtask summary
      const { rows } = await this.db.query(
        `SELECT
           t.id,
           t.title,
           t.status,
           t.projeto_id,
           t.created_at,
           t.completed_at,
           COALESCE(sub.total_subtasks, 0) AS total_subtasks,
           COALESCE(sub.verified_count, 0) AS verified_count,
           COALESCE(sub.running_count, 0) AS running_count,
           COALESCE(sub.blocked_count, 0) AS blocked_count,
           COALESCE(sub.pending_count, 0) AS pending_count,
           COALESCE(sub.total_weight, 0) AS total_weight,
           COALESCE(sub.accepted_weight, 0) AS accepted_weight
         FROM tarefas t
         LEFT JOIN (
           SELECT
             s.tarefa_id,
             COUNT(*) AS total_subtasks,
             SUM(CASE WHEN s.status IN ('verified', 'completed') THEN 1 ELSE 0 END) AS verified_count,
             SUM(CASE WHEN s.status IN ('running', 'delivered', 'verifying', 'rework') THEN 1 ELSE 0 END) AS running_count,
             SUM(CASE WHEN s.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
             SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
             SUM(COALESCE(s.weight, 1)) AS total_weight,
             SUM(CASE WHEN s.status IN ('verified', 'completed') THEN COALESCE(s.weight, 1) ELSE 0 END) AS accepted_weight
           FROM subtarefas s
           WHERE s.status NOT IN ('skipped')
             AND (s.superseded_by_subtask_id IS NULL OR s.status != 'superseded')
           GROUP BY s.tarefa_id
         ) sub ON sub.tarefa_id = t.id
         ${where}
         ORDER BY t.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      )

      const tasks = rows.map((row: Record<string, unknown>) => {
        const totalWeight = Number(row.total_weight) || 0
        const acceptedWeight = Number(row.accepted_weight) || 0
        const totalSubtasks = Number(row.total_subtasks) || 0
        const verifiedCount = Number(row.verified_count) || 0
        const runningCount = Number(row.running_count) || 0
        const blockedCount = Number(row.blocked_count) || 0

        return {
          id: String(row.id),
          title: String(row.title ?? ''),
          status: String(row.status),
          projectId: Number(row.projeto_id),
          createdAt: String(row.created_at),
          completedAt: row.completed_at ? String(row.completed_at) : null,
          subtasks: {
            total: totalSubtasks,
            verified: verifiedCount,
            running: runningCount,
            blocked: blockedCount,
            pending: Number(row.pending_count) || 0,
          },
          advancement: {
            totalWeight,
            acceptedWeight,
            acceptedAdvancement: totalWeight > 0 ? acceptedWeight / totalWeight : null,
            operationalProgress: totalSubtasks > 0
              ? (verifiedCount + runningCount + blockedCount) / totalSubtasks
              : null,
          },
        }
      })

      this.json(res, 200, {
        ok: true,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
        tasks,
      })
    } catch (error) {
      this.logger.error('Failed to get metrics tasks', { error })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  /**
   * Parse query params into MetricsFilter.
   */
  private parseMetricsFilter(url: URL): MetricsFilter {
    const filter: MetricsFilter = {}

    const projectId = url.searchParams.get('projectId')
    if (projectId != null) {
      const num = Number(projectId)
      if (!Number.isNaN(num)) filter.projectId = num
    }

    const taskId = url.searchParams.get('taskId')
    if (taskId != null) {
      const num = Number(taskId)
      if (!Number.isNaN(num)) filter.taskId = num
    }

    const from = url.searchParams.get('from')
    if (from != null) {
      const date = new Date(from)
      if (!Number.isNaN(date.getTime())) filter.from = date
    }

    const to = url.searchParams.get('to')
    if (to != null) {
      const date = new Date(to)
      if (!Number.isNaN(date.getTime())) filter.to = date
    }

    return filter
  }

  /**
   * Format metrics result for API response.
   * Ensures null values are explicit and data_quality is always present.
   */
  private formatMetricsResponse(result: AdvancementMetricsResult): Record<string, unknown> {
    return {
      // Escopo
      totalWeightedScope: result.totalWeightedScope,

      // Avanço aceito (null se dados insuficientes)
      acceptedAdvancement: result.acceptedAdvancement,

      // Progresso operacional (null se dados insuficientes)
      operationalProgress: result.operationalProgress,

      // Itens bloqueados
      blockedItems: result.blockedItems,

      // Taxas
      firstAttemptApprovalRate: result.firstAttemptApprovalRate,
      reworkRate: result.reworkRate,
      blockerRate: result.blockerRate,

      // Tempos
      medianLeadTimeSeconds: result.medianLeadTimeSeconds,
      totalBlockedTimeSeconds: result.totalBlockedTimeSeconds,

      // Gates e deploy
      gateSuccessRate: result.gateSuccessRate,
      deployReliability: result.deployReliability,

      // Qualidade de dados — sempre presente
      dataQuality: {
        weightCoverage: result.dataQuality.weightCoverage,
        deadlineCoverage: result.dataQuality.deadlineCoverage,
        durationCoverage: result.dataQuality.durationCoverage,
        gateCoverage: result.dataQuality.gateCoverage,
        warnings: result.dataQuality.warnings,
      },

      // Metadados
      filter: {
        projectId: result.filter.projectId ?? null,
        taskId: result.filter.taskId ?? null,
        from: result.filter.from ? result.filter.from.toISOString() : null,
        to: result.filter.to ? result.filter.to.toISOString() : null,
      },
      computedAt: result.computedAt.toISOString(),
    }
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        if (!data.trim()) { resolve(null); return }
        try {
          resolve(JSON.parse(data) as Record<string, unknown>)
        } catch (error) {
          reject(new Error('Body JSON inválido'))
        }
      })
      req.on('error', reject)
    })
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  /**
   * GET /api/model-selection/:projectKey/:tipo — lista a seleção de modelos
   * do projeto para o tipo (DEV/ANALYST/MONITOR). 404 se não houver seleção.
   */
  private async handleGetModelSelection(res: ServerResponse, projectKey: string, tipo: string): Promise<void> {
    if (!this.db) {
      this.json(res, 503, { ok: false, error: 'Database not available' })
      return
    }

    const validTipos = ['DEV', 'ANALYST', 'MONITOR']
    if (!validTipos.includes(tipo)) {
      this.json(res, 400, { ok: false, error: `Invalid tipo: ${tipo}` })
      return
    }

    try {
      const result = await this.db.query(
        `SELECT ordem, provider, model, enabled
         FROM project_model_selection
         WHERE project_slug = ? AND tipo = ?
         ORDER BY ordem ASC`,
        [projectKey, tipo]
      )

      if (result.rows.length === 0) {
        this.json(res, 404, { ok: false, error: 'No model selection found' })
        return
      }

      const entries = result.rows.map((row: any) => ({
        ordem: Number(row.ordem),
        provider: row.provider,
        model: row.model,
        enabled: Boolean(row.enabled)
      }))

      this.json(res, 200, { projectKey, tipo, entries })
    } catch (error) {
      this.logger.error('Failed to get model selection', { error, projectKey, tipo })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  /**
   * PUT /api/model-selection/:projectKey/:tipo — salva a seleção de modelos.
   * Substitui todas as entradas existentes para o projectKey/tipo.
   */
  private async handleSaveModelSelection(req: IncomingMessage, res: ServerResponse, projectKey: string, tipo: string): Promise<void> {
    if (!this.db) {
      this.json(res, 503, { ok: false, error: 'Database not available' })
      return
    }

    const validTipos = ['DEV', 'ANALYST', 'MONITOR']
    if (!validTipos.includes(tipo)) {
      this.json(res, 400, { ok: false, error: `Invalid tipo: ${tipo}` })
      return
    }

    try {
      const body = await this.readBody(req)
      const entries = body?.entries as Array<{ ordem: number; provider: string; model: string; enabled: boolean }> | undefined

      if (!Array.isArray(entries) || entries.length === 0) {
        this.json(res, 400, { ok: false, error: 'entries must be a non-empty array' })
        return
      }

      // Valida cada entrada
      for (const entry of entries) {
        if (!entry.provider || !entry.model || typeof entry.ordem !== 'number') {
          this.json(res, 400, { ok: false, error: 'Each entry must have provider, model, and ordem' })
          return
        }
      }

      // Deleta entradas existentes e insere novas (transação implícita)
      await this.db.query(
        `DELETE FROM project_model_selection WHERE project_slug = ? AND tipo = ?`,
        [projectKey, tipo]
      )

      for (const entry of entries) {
        await this.db.query(
          `INSERT INTO project_model_selection (project_slug, tipo, ordem, provider, model, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [projectKey, tipo, entry.ordem, entry.provider, entry.model, entry.enabled ? 1 : 0]
        )
      }

      this.logger.info('Model selection saved', { projectKey, tipo, entriesCount: entries.length })
      this.json(res, 200, { projectKey, tipo, entries })
    } catch (error) {
      this.logger.error('Failed to save model selection', { error, projectKey, tipo })
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  /**
   * GET /api/modelos-console — lista modelos disponíveis.
   * Por enquanto retorna uma lista estática; no futuro pode consultar o
   * OpenClaw Console ou uma tabela de configuração.
   */
  private async handleListModelsConsole(res: ServerResponse): Promise<void> {
    // Lista estática de modelos conhecidos (pode ser expandida ou movida para config)
    const models = [
      { id: 'alibaba/qwen3.7-plus', name: 'Qwen 3.7 Plus', provider: 'alibaba' },
      { id: 'alibaba/qwen3.7-max', name: 'Qwen 3.7 Max', provider: 'alibaba' },
      { id: 'alibaba/qwen3.8-max', name: 'Qwen 3.8 Max', provider: 'alibaba' },
      { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai' },
      { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai' },
      { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai' },
      { id: 'ollama/qwen3.7-plus', name: 'Qwen 3.7 Plus (local)', provider: 'ollama' },
      { id: 'ollama/gpt-oss:20b', name: 'GPT-OSS 20B (local)', provider: 'ollama' },
      { id: 'ollama/qwen3.6:35b', name: 'Qwen 3.6 35B (local)', provider: 'ollama' },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek' },
    ]

    this.json(res, 200, { models })
  }
}
