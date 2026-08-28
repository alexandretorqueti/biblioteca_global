/**
 * MotorAPI - Endpoints REST para o Motor v2
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { TaskCoordinator } from '../coordinator/TaskCoordinator.js'

export interface MotorAPIConfig {
  port: number
  coordinator: TaskCoordinator
}

export class MotorAPI {
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
        console.log(`[MotorAPI] Porta ${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return }
      this.server.close((err) => { err ? reject(err) : resolve() })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === '/api/motor/health') {
        this.json(res, 200, { ok: true, runtime: 'motor-v2', timestamp: new Date().toISOString() })
      } else if (req.method === 'GET' && path === '/api/motor/stats') {
        this.json(res, 200, this.coordinator.getStats())
      } else if (req.method === 'POST' && path === '/api/motor/pump') {
        this.coordinator.pump().then(() => this.json(res, 200, { ok: true }))
      } else {
        this.json(res, 404, { ok: false, error: 'Not found' })
      }
    } catch (error) {
      this.json(res, 500, { ok: false, error: error instanceof Error ? error.message : 'Internal error' })
    }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
}
