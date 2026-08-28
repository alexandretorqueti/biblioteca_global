/**
 * Motor v2 API - Endpoints REST
 * 
 * Etapa 10: API simples para interagir com o motor
 * Usa http nativo do Node (sem dependências externas)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import type { TaskCoordinator } from '../coordinator/TaskCoordinator.js'

export interface MotorAPIConfig {
  port: number
  coordinator: TaskCoordinator
}

export class MotorAPI {
  private server: ReturnType<typeof createServer> | null = null
  private coordinator: TaskCoordinator
  private port: number

  constructor(config: MotorAPIConfig) {
    this.port = config.port
    this.coordinator = config.coordinator

    this.server = createServer(async (req, res) => {
      await this.handleRequest(req, res)
    })
  }

  /**
   * Inicia servidor
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.listen(this.port, () => {
        console.log(`[MotorAPI] Servidor iniciado na porta ${this.port}`)
        resolve()
      })
    })
  }

  /**
   * Para servidor
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve()
        return
      }

      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * Handler de requisições
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === '/api/motor/health') {
        this.handleHealth(res)
      } else if (req.method === 'GET' && path === '/api/motor/stats') {
        this.handleStats(res)
      } else if (req.method === 'POST' && path === '/api/motor/pump') {
        await this.handlePump(res)
      } else if (req.method === 'GET' && path.startsWith('/api/motor/task/')) {
        const taskId = path.split('/').pop()
        if (taskId) {
          await this.handleGetTask(taskId, res)
        } else {
          this.sendError(res, 400, 'Task ID required')
        }
      } else if (req.method === 'POST' && path === '/api/motor/shutdown') {
        this.handleShutdown(res)
      } else {
        this.sendError(res, 404, 'Not found')
      }
    } catch (error) {
      console.error('[MotorAPI] Erro:', error)
      this.sendError(res, 500, error instanceof Error ? error.message : 'Internal error')
    }
  }

  /**
   * Health check
   */
  private handleHealth(res: ServerResponse): void {
    this.sendJSON(res, 200, {
      ok: true,
      runtime: 'motor-v2',
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Estatísticas do motor
   */
  private handleStats(res: ServerResponse): void {
    const stats = this.coordinator.getStats()
    this.sendJSON(res, 200, stats)
  }

  /**
   * Força pump manual
   */
  private async handlePump(res: ServerResponse): Promise<void> {
    await this.coordinator.pump()
    this.sendJSON(res, 200, { ok: true, message: 'Pump executado' })
  }

  /**
   * Obtém detalhes de uma tarefa
   */
  private async handleGetTask(taskId: string, res: ServerResponse): Promise<void> {
    // TODO: Implementar busca de tarefa via repository
    this.sendJSON(res, 200, { taskId, status: 'not_implemented' })
  }

  /**
   * Shutdown gracioso
   */
  private handleShutdown(res: ServerResponse): void {
    this.sendJSON(res, 200, { ok: true, message: 'Shutdown iniciado' })
    
    setTimeout(() => {
      this.stop().then(() => {
        console.log('[MotorAPI] Servidor parado')
        process.exit(0)
      })
    }, 1000)
  }

  /**
   * Envia resposta JSON
   */
  private sendJSON(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data, null, 2))
  }

  /**
   * Envia erro
   */
  private sendError(res: ServerResponse, status: number, message: string): void {
    this.sendJSON(res, status, { ok: false, error: message })
  }
}
