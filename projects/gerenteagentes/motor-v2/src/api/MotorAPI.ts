/**
 * MotorAPI - Endpoints REST para o Motor v2
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { TaskCoordinator } from '../coordinator/TaskCoordinator.js'
import { createLogger } from '../shared/logger.js'

export interface MotorAPIConfig {
  port: number
  coordinator: TaskCoordinator
}

export class MotorAPI {
  private logger = createLogger('MotorAPI')
  private server: Server | null = null
  private coordinator: TaskCoordinator
  private port: number

  constructor(config: MotorAPIConfig) {
    this.port = config.port
    this.coordinator = config.coordinator
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

    try {
      if (req.method === 'GET' && path === '/api/motor/health') {
        this.json(res, 200, { ok: true, runtime: 'motor-v2', timestamp: new Date().toISOString() })
      } else if (req.method === 'GET' && path === '/api/motor/stats') {
        this.json(res, 200, this.coordinator.getStats())
      } else if (req.method === 'POST' && path === '/api/motor/pump') {
        this.coordinator.pump().then(() => this.json(res, 200, { ok: true }))
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
}
