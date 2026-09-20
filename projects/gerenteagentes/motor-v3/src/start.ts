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
import { QueueConsumer } from './queue/QueueConsumer.js'
import { RabbitMqTransport } from './queue/RabbitMqTransport.js'
import { OutboxPublisher, createQueueMessage } from './queue/index.js'
import type { QueueMessage } from './queue/QueueMessage.js'
import { TaskCoordinator, MySqlTaskCoordinatorRepository } from './coordinator/index.js'
import { ConsoleAnalystRunner } from './analysis/ConsoleAnalystRunner.js'
import { ConsoleHttpApi } from './analysis/ConsoleHttpApi.js'
import { DerivedTaskStatusResolver } from './status/DerivedTaskStatus.js'

// Config
const PORT = parseInt(process.env.MOTOR_PORT || '3010')
const DB_CONFIG = {
  // A API usa o banco "core"; o catálogo operacional do Motor vive em
  // projeto_640. Permitir configuração própria evita que o Motor tente ler
  // tabelas motor_* no banco da plataforma.
  host: process.env.MOTOR_MYSQL_HOST || process.env.MYSQL_HOST || 'host.docker.internal',
  port: parseInt(process.env.MOTOR_MYSQL_PORT || process.env.MYSQL_PORT || '3308'),
  user: process.env.MOTOR_MYSQL_USER || process.env.MYSQL_USER || 'biblioteca',
  password: process.env.MOTOR_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database: process.env.MOTOR_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'projeto_640',
  charset: 'utf8mb4',
}

// Estado global (para graceful shutdown)
let server: any = null
let scheduler: Scheduler | null = null
let bus: MessageBus | null = null
let queueConsumer: QueueConsumer | null = null
let outboxPublisher: OutboxPublisher | null = null

async function start() {
  console.log('[Motor v3] Iniciando...')

  // 1. Conecta ao MySQL
  console.log('[Motor v3] Conectando ao MySQL...')
  console.log('[Motor v3] DB_CONFIG:', { ...DB_CONFIG, password: '***' })
  const pool = await mysql.createPool(DB_CONFIG)
  const db = drizzle(pool, { schema, mode: 'default' })
  const statusResolver = new DerivedTaskStatusResolver(pool)
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

  // 8. Fila durável e coordenador (opt-in até RabbitMQ/outbox estarem ativos)
  if (process.env.MOTOR_QUEUE_ENABLED === 'true') {
    const rabbitUrl = process.env.MOTOR_RABBITMQ_URL
    const consoleUrl = process.env.OPENCLAW_CONSOLE_URL
    const consoleToken = process.env.OPENCLAW_CONSOLE_TOKEN
    if (!rabbitUrl || !consoleUrl || !consoleToken) {
      throw new Error('MOTOR_QUEUE_ENABLED exige MOTOR_RABBITMQ_URL, OPENCLAW_CONSOLE_URL e OPENCLAW_CONSOLE_TOKEN')
    }

    const repository = new MySqlTaskCoordinatorRepository(pool)
    const analyst = new ConsoleAnalystRunner(new ConsoleHttpApi(consoleUrl, consoleToken), {
      timeoutMs: Number(process.env.MOTOR_ANALYSIS_TIMEOUT_MS || 1800000),
      pollIntervalMs: Number(process.env.MOTOR_ANALYSIS_POLL_INTERVAL_MS || 5000),
    })
    const coordinator = new TaskCoordinator(repository, analyst, bus)
    const transport = new RabbitMqTransport({
      url: rabbitUrl,
      exchange: process.env.MOTOR_RABBITMQ_EXCHANGE || 'motor',
      prefetch: Number(process.env.MOTOR_RABBITMQ_PREFETCH || 1),
      queue: process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands',
      retryQueue: process.env.MOTOR_RABBITMQ_RETRY_QUEUE || 'motor.commands.retry',
      deadLetterQueue: process.env.MOTOR_RABBITMQ_DLQ || 'motor.commands.dlq',
      retryDelayMs: Number(process.env.MOTOR_RABBITMQ_RETRY_DELAY_MS || 30000),
    })
    outboxPublisher = new OutboxPublisher(pool, transport, process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands')
    await outboxPublisher.start()
    queueConsumer = new QueueConsumer(transport, message => coordinator.handle(message), {
      queue: process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands',
      maxAttempts: Number(process.env.MOTOR_QUEUE_MAX_ATTEMPTS || 3),
    }, pool)
    await queueConsumer.start()
    console.log('[Motor v3] QueueConsumer + TaskCoordinator inicializados')
  } else {
    console.log('[Motor v3] Fila durável desativada (MOTOR_QUEUE_ENABLED != true)')
  }

  const dispatchCommand = async (type: string, taskId: string, executionId: string, payload: Record<string, unknown>): Promise<QueueMessage> => {
    const message = createQueueMessage({ type, taskId, executionId, payload })
    if (outboxPublisher) {
      await outboxPublisher.enqueue(message)
    } else {
      await bus?.emit(type, { taskId, executionId, payload })
    }
    return message
  }

  // 9. Inicia API HTTP (http nativo)
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
      
      // ============================================================
      // Task management endpoints (v2 API compatibility)
      // ============================================================
      const taskMatch = path.match(/^\/api\/motor\/task\/([^/]+)(?:\/(.+))?$/)
      const taskId = taskMatch?.[1]
      const taskAction = taskMatch?.[2]
      
      // POST /api/motor/pump
      if (req.method === 'POST' && path === '/api/motor/pump') {
        console.log('[Motor v3] Pump triggered')
        await dispatchCommand('PUMP_TRIGGERED', 'system', 'system', {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      
      // GET /api/motor/tasks/by-status
      if (req.method === 'GET' && path === '/api/motor/tasks/by-status') {
        const executions = scheduler?.getActiveExecutions() ?? []
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ executions }))
        return
      }
      
      // GET /api/motor/task/:id
      if (req.method === 'GET' && taskId && !taskAction) {
        try {
          // Usa mysql2 diretamente para queries SQL (Drizzle não suporta query() nativamente)
          const [tarefaRow] = await pool.query(
            `SELECT t.*, p.nome as projetoNome
             FROM tarefas t
             LEFT JOIN projetos_captados p ON t.projeto_id = p.id
             WHERE t.external_id = ? OR t.id = ?
             LIMIT 1`,
            [taskId, taskId.replace('task-', '')]
          ) as any[]

          const tarefa = tarefaRow?.[0]
          if (!tarefa) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Task not found', exists: false }))
            return
          }

          // Busca subtarefas
          const [subtasksRows] = await pool.query(
            `SELECT * FROM subtarefas WHERE tarefa_id = ? ORDER BY seq`,
            [tarefa.id]
          ) as any[]

          const execution = scheduler?.getActiveExecutions().find(e => e.taskId === taskId)
          const status = await statusResolver.resolve(taskId)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            exists: true,
            ...tarefa,
            status,
            queueStatus: execution ? 'processing' : 'queued',
            subtasks: subtasksRows || [],
            recoveryEligibility: null, // O motor-v3 não tem dados de recuperação ainda
          }))
          return
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
          return
        }
      }
      
      // POST /api/motor/task/:id/enqueue
      if (req.method === 'POST' && taskId && taskAction === 'enqueue') {
        let body = ''
        req.on('data', chunk => body += chunk)
        await new Promise(resolve => req.on('end', resolve))
        const taskData = body ? JSON.parse(body) : {}
        console.log(`[Motor v3] Task ${taskId} enqueued:`, JSON.stringify(taskData).slice(0, 200))
        const executionId = `exec-${taskId}-${Date.now()}`
        await dispatchCommand('TASK_ENQUEUED', taskId, executionId, { ...taskData })
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, taskId, executionId }))
        return
      }
      
      // POST /api/motor/task/:id/pause
      if (req.method === 'POST' && taskId && taskAction === 'pause') {
        console.log(`[Motor v3] Task ${taskId} pause requested`)
        await dispatchCommand('TASK_PAUSE_REQUESTED', taskId, taskId, {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, taskId }))
        return
      }
      
      // POST /api/motor/task/:id/resume
      if (req.method === 'POST' && taskId && taskAction === 'resume') {
        console.log(`[Motor v3] Task ${taskId} resume requested`)
        await dispatchCommand('TASK_RESUME_REQUESTED', taskId, taskId, {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, taskId }))
        return
      }
      
      // POST /api/motor/task/:id/cancel
      if (req.method === 'POST' && taskId && taskAction === 'cancel') {
        console.log(`[Motor v3] Task ${taskId} cancel requested`)
        await dispatchCommand('TASK_CANCEL_REQUESTED', taskId, taskId, {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, taskId }))
        return
      }

      // DELETE /api/motor/task/:id
      // Mantém a compatibilidade com o contrato do motor v2. A exclusão
      // definitiva é feita aqui porque esta é a origem de verdade operacional
      // usada pela API para remover a tarefa e suas relações em cascata.
      if (req.method === 'DELETE' && taskId && !taskAction) {
        const [taskRows] = await pool.query<any[]>(
          `SELECT t.id, t.external_id,
                  COALESCE(f.terminal_status, '') AS terminal_status,
                  f.analysis_started_at,
                  (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count
             FROM tarefas t
             LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
            WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
            LIMIT 1`,
          [taskId, taskId],
        )
        const task = taskRows[0]
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Task not found' }))
          return
        }

        const activeExecution = scheduler?.getActiveExecutions().find((execution) => execution.taskId === taskId)
        if (activeExecution || task.analysis_started_at) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: `Tarefa ${taskId} ainda está em execução; cancele antes de excluir` }))
          return
        }

        await pool.query('DELETE FROM tarefas WHERE id = ?', [task.id])
        console.log(`[Motor v3] Task ${taskId} deleted`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
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

  if (queueConsumer) {
    await queueConsumer.stop()
    console.log('[Motor v3] QueueConsumer parado')
  }

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
