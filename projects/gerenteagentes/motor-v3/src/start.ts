/**
 * Motor v3 — Entrypoint
 * 
 * Inicializa todos os módulos e conecta ao MessageBus:
 * 1. Conecta ao MySQL
 * 2. Inicializa MessageBus + EventLogger
 * 3. Carrega catálogo (CatalogLoader)
 * 4. Registra primitivas (ActionExecutor)
 * 5. Inicializa EventClassifier
 * 6. Inicializa Scheduler
 * 7. Inicializa Monitor Bridge
 * 8. Inicia API HTTP (Fastify)
 * 9. Registra handlers de sinais (SIGTERM/SIGINT)
 */

import 'dotenv/config'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from './db/schema.js'
import { MessageBus } from './bus/MessageBus.js'
import { EventLogger } from './bus/EventLogger.js'
import { CatalogLoader } from './catalog/CatalogLoader.js'
import { EventClassifier } from './classifier/EventClassifier.js'
import { ActionExecutor } from './executor/ActionExecutor.js'
import { registerAllPrimitives } from './primitives/index.js'
import { Scheduler } from './scheduler/Scheduler.js'
import { MonitorBridge } from './monitor-bridge/MonitorBridge.js'

// Config
const PORT = parseInt(process.env.MOTOR_PORT || '3010')
const DB_URL = process.env.DATABASE_URL || 'mysql://root:root@localhost:3308/projeto_640'

// Estado global (para graceful shutdown)
let server: any = null
let scheduler: Scheduler | null = null
let bus: MessageBus | null = null

async function start() {
  console.log('[Motor v3] Iniciando...')

  // 1. Conecta ao MySQL
  console.log('[Motor v3] Conectando ao MySQL...')
  const pool = await mysql.createPool(DB_URL)
  const db = drizzle(pool, { schema, mode: 'default' })
  console.log('[Motor v3] MySQL conectado')

  // 2. Inicializa MessageBus + EventLogger
  console.log('[Motor v3] Inicializando MessageBus...')
  bus = new MessageBus()
  const logger = new EventLogger()
  bus.use(logger)
  console.log('[Motor v3] MessageBus inicializado')

  // 3. Carrega catálogo
  console.log('[Motor v3] Carregando catálogo...')
  const catalogLoader = new CatalogLoader(db)
  await catalogLoader.load()
  console.log('[Motor v3] Catálogo carregado')

  // 4. Registra primitivas
  console.log('[Motor v3] Registrando primitivas...')
  const executor = new ActionExecutor(db, catalogLoader)
  registerAllPrimitives(executor)
  console.log('[Motor v3] Primitivas registradas')

  // 5. Inicializa EventClassifier
  console.log('[Motor v3] Inicializando EventClassifier...')
  const classifier = new EventClassifier(db, catalogLoader)
  console.log('[Motor v3] EventClassifier inicializado')

  // 6. Inicializa Scheduler
  console.log('[Motor v3] Inicializando Scheduler...')
  scheduler = new Scheduler(bus)
  scheduler.start()
  console.log('[Motor v3] Scheduler inicializado')

  // 7. Inicializa Monitor Bridge
  console.log('[Motor v3] Inicializando Monitor Bridge...')
  const monitorBridge = new MonitorBridge(bus, catalogLoader, classifier)
  console.log('[Motor v3] Monitor Bridge inicializado')

  // 8. Inicia API HTTP (http nativo)
  console.log('[Motor v3] Iniciando API HTTP...')
  
  const http = await import('http')
  
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const path = url.pathname
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    
    try {
      // Health check
      if (path === '/api/motor/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          runtime: 'motor-v3',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        }))
        return
      }
      
      // Stats
      if (path === '/api/motor/stats' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          activeExecutions: scheduler?.getActiveExecutions().length ?? 0,
          pendingProposals: monitorBridge.getPendingProposals().length,
          catalogEvents: (await catalogLoader.getAllEvents()).length,
          catalogActions: (await catalogLoader.getAllActions()).length,
        }))
        return
      }
      
      // Catalog endpoints (leitura)
      if (path === '/api/motor/catalog/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await catalogLoader.getAllEvents()))
        return
      }
      
      if (path === '/api/motor/catalog/actions' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await catalogLoader.getAllActions()))
        return
      }
      
      if (path === '/api/motor/catalog/primitives' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(executor.getRegisteredPrimitives()))
        return
      }
      
      // Proposals endpoints
      if (path === '/api/motor/catalog/proposals' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(monitorBridge.getPendingProposals()))
        return
      }
      
      // Approve proposal
      const approveMatch = path.match(/^\/api\/motor\/catalog\/approve\/(.+)$/)
      if (approveMatch && req.method === 'POST') {
        const proposalId = approveMatch[1]!
        let body = ''
        req.on('data', chunk => body += chunk)
        await new Promise(resolve => req.on('end', resolve))
        const { reviewedBy } = body ? JSON.parse(body) : {}
        await monitorBridge.approveProposal(proposalId, reviewedBy || 'unknown')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }
      
      // Reject proposal
      const rejectMatch = path.match(/^\/api\/motor\/catalog\/reject\/(.+)$/)
      if (rejectMatch && req.method === 'POST') {
        const proposalId = rejectMatch[1]!
        let body = ''
        req.on('data', chunk => body += chunk)
        await new Promise(resolve => req.on('end', resolve))
        const { reviewedBy, reason } = body ? JSON.parse(body) : {}
        await monitorBridge.rejectProposal(proposalId, reviewedBy || 'unknown', reason)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        return
      }
      
      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Motor v3] API HTTP ouvindo na porta ${PORT}`)
    console.log('[Motor v3] Motor pronto')
  })
}

async function shutdown() {
  console.log('[Motor v3] Encerrando...')

  // Para scheduler
  if (scheduler) {
    scheduler.stop()
    console.log('[Motor v3] Scheduler parado')
  }

  // Fecha servidor HTTP
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[Motor v3] API HTTP fechada')
        resolve()
      })
    })
  }

  // Fecha pool de conexões MySQL
  // (drizzle não expõe close direto, mas pool será fechado ao sair)

  console.log('[Motor v3] Encerrado')
  process.exit(0)
}

// Registra handlers de sinais
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Inicia
start().catch(err => {
  console.error('[Motor v3] Erro fatal:', err)
  process.exit(1)
})
