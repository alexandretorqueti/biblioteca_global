/**
 * MotorAPI - Endpoints REST para o Motor v2
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { TaskCoordinator } from '../coordinator/TaskCoordinator.js'
import { createLogger } from '../shared/logger.js'
import type { Db } from '../shared/types/infrastructure.js'

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
        this.coordinator.pump().then(() => this.json(res, 200, { ok: true }))
      }
      // Model selection endpoints
      else if (req.method === 'GET' && projectKey && tipo) {
        this.handleGetModelSelection(res, projectKey, tipo)
      } else if (req.method === 'PUT' && projectKey && tipo) {
        this.handleSaveModelSelection(req, res, projectKey, tipo)
      } else if (req.method === 'GET' && path === '/api/modelos-console') {
        this.handleListModelsConsole(res)
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
    const task = await this.coordinator.getTaskWithSubtasks(taskId)
    if (!task) {
      this.json(res, 404, { ok: false, error: 'Task not found' })
      return
    }
    this.json(res, 200, task)
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
