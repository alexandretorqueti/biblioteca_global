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
import { createHash, timingSafeEqual } from 'node:crypto'
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
import { TaskCoordinator, MySqlTaskCoordinatorRepository, AnalysisClaimReconciler, AnalysisSessionRecoveryReconciler, TaskCancelConsumer, MySqlTaskEventRecorder, MySqlAnalysisFailureBlocker } from './coordinator/index.js'
import { ConsoleAnalystRunner } from './analysis/ConsoleAnalystRunner.js'
import { ConsoleHttpApi } from './analysis/ConsoleHttpApi.js'
import { ManagedAnalysisPromptResolver } from './analysis/ManagedAnalysisPromptResolver.js'
import { DerivedTaskStatusResolver } from './status/DerivedTaskStatus.js'
import { MySqlCommandPolicyRepository, MySqlOperationLogger } from './commands/index.js'
import { DevelopmentExecutionConsumer, GitVerificationIntegrator, GitWorktreePreparer, MySqlDevelopmentExecutionRepository, SubtaskExecutionConsumer, SubtaskVerificationConsumer, WorkerConsoleAdapter } from './execution/index.js'
import { WorkerLauncher } from './worker-launcher/WorkerLauncher.js'
import { getDeployDiagnostics } from './deploy/DeployDiagnostics.js'
import { DeployConsumer } from './deploy/DeployConsumer.js'
import { DeployRepository } from './deploy/DeployRepository.js'
import { RemoteBlueGreenDeployer } from './deploy/RemoteBlueGreenDeployer.js'
import { BaselinePreflightRecovery, TestGateConsumer, TestGateJobReconciler, TestGateOrchestrator, TestGateService, TestRecoveryConsumer, WorkspaceEnvironmentPreparer } from './testing/index.js'
import { ConsoleHumanNotifier, ExternalResolutionError, ExternalResolutionHandler, MonitorPromptResolver, MonitorResolutionConsumer, TaskUnblockedConsumer, createTaskBlockedMessage, loadActiveBlocker } from './monitor/index.js'
import { ensureCompletionTrigger } from './db/ensureTriggers.js'

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
let developmentConsumer: DevelopmentExecutionConsumer | null = null
let subtaskExecutionConsumer: SubtaskExecutionConsumer | null = null
let subtaskVerificationConsumer: SubtaskVerificationConsumer | null = null
let testRecoveryConsumer: TestRecoveryConsumer | null = null
let monitorResolutionConsumer: MonitorResolutionConsumer | null = null
let taskUnblockedConsumer: TaskUnblockedConsumer | null = null
let testGateQueueConsumer: QueueConsumer | null = null
let testGateOutboxPublisher: OutboxPublisher | null = null
let testGateJobReconciler: TestGateJobReconciler | null = null
let deployConsumer: DeployConsumer | null = null
let cancelConsumer: TaskCancelConsumer | null = null
let analysisSessionRecovery: AnalysisSessionRecoveryReconciler | null = null

async function start() {
  console.log('[Motor v3] Iniciando...')

  // 1. Conecta ao MySQL
  console.log('[Motor v3] Conectando ao MySQL...')
  console.log('[Motor v3] DB_CONFIG:', { ...DB_CONFIG, password: '***' })
  const pool = await mysql.createPool(DB_CONFIG)
  const db = drizzle(pool, { schema, mode: 'default' })
  const statusResolver = new DerivedTaskStatusResolver(pool)
  const externalResolutionHandler = new ExternalResolutionHandler(pool)

  // Camada A do invariante de conclusão: trigger de rede de segurança para
  // escritas externas em subtarefas. Falha não derruba o boot (camadas B/C
  // seguem ativas), mas fica logada em destaque.
  try {
    await ensureCompletionTrigger(pool)
  } catch (error) {
    console.error('[Motor v3] FALHA ao instalar trigger de conclusão (camada A):', error instanceof Error ? error.message : String(error))
  }
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
    const consoleApi = new ConsoleHttpApi(consoleUrl, consoleToken)
    const analystSessionRows = new Map<string, number>()
    const analystSessionSequences = new Map<string, number>()
    const resolveTaskNumericId = async (taskId: string): Promise<number | null> => {
      const [rows] = await pool.query<any[]>('SELECT id FROM tarefas WHERE external_id = ? LIMIT 1', [taskId])
      if (rows[0]?.id) return Number(rows[0].id)
      const numericId = Number(taskId.match(/(\d+)$/)?.[1])
      return Number.isInteger(numericId) ? numericId : null
    }
    const auditAnalyst = async (operation: () => Promise<void>): Promise<void> => {
      try { await operation() } catch (error) {
        console.warn('[Motor v3] Falha ao persistir auditoria da sessão do analista:', error instanceof Error ? error.message : String(error))
      }
    }
    const analyst = new ConsoleAnalystRunner(consoleApi, {
      // Margem antes do consumer_timeout padrão do RabbitMQ (30 minutos),
      // para que a entrega possa ser rejeitada/repetida sem fechar o canal.
      timeoutMs: Number(process.env.MOTOR_ANALYSIS_TIMEOUT_MS || 1500000),
      pollIntervalMs: Number(process.env.MOTOR_ANALYSIS_POLL_INTERVAL_MS || 5000),
      promptResolver: new ManagedAnalysisPromptResolver(pool),
      modelChainResolver: async (task) => {
        if (!task.projectSlug) return []
        const [rows] = await pool.query<any[]>(
          `SELECT selection.model FROM project_model_selection selection
            WHERE selection.project_slug = ? AND selection.tipo = 'ANALYST' AND selection.enabled = 1
              AND NOT EXISTS (
                SELECT 1 FROM motor_model_cooldown cooldown
                 WHERE cooldown.model COLLATE utf8mb4_unicode_ci = selection.model COLLATE utf8mb4_unicode_ci
                   AND cooldown.until > NOW()
              )
            ORDER BY selection.ordem ASC`,
          [task.projectSlug],
        )
        return rows.map(row => String(row.model)).filter(Boolean)
      },
      modelFailureRecorder: async (model, error) => {
        const reason = error.message.slice(0, 100)
        const [updated] = await pool.query<any>(
          `UPDATE motor_model_cooldown
              SET until = DATE_ADD(NOW(), INTERVAL 10 MINUTE), reason = ?,
                  occurrences = occurrences + 1, updated_at = NOW()
            WHERE model = ? AND until > NOW()`, [reason, model],
        )
        if (updated.affectedRows === 0) {
          await pool.query(
            `INSERT INTO motor_model_cooldown (model, reason, until, occurrences, created_at, updated_at)
             VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 1, NOW(), NOW())`, [model, reason],
          )
        }
      },
      onSessionCreated: async (session, context) => auditAnalyst(async () => {
        const tarefaId = await resolveTaskNumericId(context.taskId)
        if (!tarefaId) return
        const [result] = await pool.query<any>(
          `INSERT INTO analyst_task_sessions
             (tarefa_id, session_key, runtime_session_id, model, execution_order,
              analysis_execution_id, analysis_attempt_id, model_attempt, status, opened_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`,
          [tarefaId, session.sessionKey, session.sessionId, context.model ?? 'console-default', context.modelAttempt,
            context.executionId, context.analysisAttemptId, context.modelAttempt],
        )
        analystSessionRows.set(session.sessionId, Number(result.insertId))
        analystSessionSequences.set(session.sessionId, 0)
      }),
      onSessionResumed: async (session) => auditAnalyst(async () => {
        const [rows] = await pool.query<any[]>(`SELECT s.id, COALESCE(MAX(m.sequence_number), 0) AS last_sequence
          FROM analyst_task_sessions s LEFT JOIN analyst_task_session_messages m ON m.session_id = s.id
          WHERE s.runtime_session_id = ? AND s.status = 'active' GROUP BY s.id ORDER BY s.id DESC LIMIT 1`, [session.sessionId])
        if (!rows[0]?.id) return
        analystSessionRows.set(session.sessionId, Number(rows[0].id))
        analystSessionSequences.set(session.sessionId, Number(rows[0].last_sequence ?? 0))
        await pool.query('UPDATE analyst_task_sessions SET last_activity_at = NOW() WHERE id = ?', [rows[0].id])
      }),
      onMessageSent: async (session, message, context) => auditAnalyst(async () => {
        const sessionRowId = analystSessionRows.get(session.sessionId)
        if (!sessionRowId || !context.messageKey) return
        const sequence = (analystSessionSequences.get(session.sessionId) ?? 0) + 1
        analystSessionSequences.set(session.sessionId, sequence)
        const content = String(message)
        await pool.query(
          `INSERT INTO analyst_task_session_messages
             (session_id, message_key, sequence_number, role, phase, run_id, content, content_sha256, occurred_at)
           VALUES (?, ?, ?, 'user', ?, ?, ?, ?, NOW())`,
          [sessionRowId, context.messageKey, sequence, context.phase, context.messageKey, content, createHash('sha256').update(content).digest('hex')],
        )
        await pool.query('UPDATE analyst_task_sessions SET last_activity_at = NOW() WHERE id = ?', [sessionRowId])
      }),
      onResponseReceived: async (session, response, context) => auditAnalyst(async () => {
        const sessionRowId = analystSessionRows.get(session.sessionId)
        if (!sessionRowId) return
        const sequence = (analystSessionSequences.get(session.sessionId) ?? 0) + 1
        analystSessionSequences.set(session.sessionId, sequence)
        const content = String(response)
        const messageKey = `${context.messageKey ?? context.analysisAttemptId}:response:${sequence}`
        await pool.query(
          `INSERT INTO analyst_task_session_messages
             (session_id, message_key, sequence_number, role, phase, run_id, content, content_sha256, occurred_at)
           VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, NOW())`,
          [sessionRowId, messageKey, sequence, context.phase, context.messageKey ?? null, content, createHash('sha256').update(content).digest('hex')],
        )
        await pool.query('UPDATE analyst_task_sessions SET last_activity_at = NOW() WHERE id = ?', [sessionRowId])
      }),
      onSessionCompleted: async (session) => auditAnalyst(async () => {
        const sessionRowId = analystSessionRows.get(session.sessionId)
        if (sessionRowId) await pool.query(`UPDATE analyst_task_sessions SET status = 'completed', close_reason = 'analysis_completed', closed_at = NOW(), last_activity_at = NOW() WHERE id = ?`, [sessionRowId])
      }),
      onSessionFailure: async (session, error, context) => auditAnalyst(async () => {
        const sessionRowId = session ? analystSessionRows.get(session.sessionId) : undefined
        if (sessionRowId) await pool.query(`UPDATE analyst_task_sessions SET status = 'failed', close_reason = 'analysis_failed', closed_at = NOW(), last_activity_at = NOW() WHERE id = ?`, [sessionRowId])
        const tarefaId = await resolveTaskNumericId(context.taskId)
        if (!tarefaId || !session) return
        const message = error.message.slice(0, 500)
        const fingerprint = createHash('sha256').update(`${context.phase}|${message}`).digest('hex')
        await pool.query(
          `INSERT INTO motor_agent_session_failures
             (tarefa_id, agent_id, session_key, runtime_session_id, analysis_execution_id,
              analysis_attempt_id, phase, run_id, code, message, occurred_at, classification,
              classification_reason, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
          [tarefaId, session.agentId, session.sessionKey, session.sessionId, context.executionId,
            context.analysisAttemptId, context.phase, context.messageKey ?? context.analysisAttemptId,
            'ANALYSIS_SESSION_FAILED', message, /timeout|429|rate|gateway|network|console|session/i.test(message) ? 'transient' : 'permanent',
            'motor_v3_analysis_runner', fingerprint],
        )
      }),
    })
    const transport = new RabbitMqTransport({
      url: rabbitUrl,
      exchange: process.env.MOTOR_RABBITMQ_EXCHANGE || 'motor',
      prefetch: Number(process.env.MOTOR_RABBITMQ_PREFETCH || 1),
      queue: process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands',
      retryQueue: process.env.MOTOR_RABBITMQ_RETRY_QUEUE || 'motor.commands.retry',
      deadLetterQueue: process.env.MOTOR_RABBITMQ_DLQ || 'motor.commands.dlq',
      retryDelayMs: Number(process.env.MOTOR_RABBITMQ_RETRY_DELAY_MS || 30000),
    })
    const mainQueue = process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands'
    const gateQueue = process.env.MOTOR_TEST_GATE_QUEUE || 'motor.test-gates'
    outboxPublisher = new OutboxPublisher(pool, transport, mainQueue, mainQueue)
    await outboxPublisher.start()
    const operationLogger = new MySqlOperationLogger(pool)
    const taskEvents = new MySqlTaskEventRecorder(pool)
    const coordinator = new TaskCoordinator(repository, analyst, bus, {
      commandPolicies: new MySqlCommandPolicyRepository(pool),
      operationLogger,
      taskEvents,
      analysisFailure: new MySqlAnalysisFailureBlocker(pool),
      maxAnalysisAttempts: Number(process.env.MOTOR_QUEUE_MAX_ATTEMPTS || 3),
      publishTaskReady: async (source, payload) => {
        if (!outboxPublisher) throw new Error('Outbox indisponível para TASK_READY_FOR_PROGRAMMING')
        await outboxPublisher.enqueue(createQueueMessage({
          type: 'TASK_READY_FOR_PROGRAMMING',
          taskId: source.taskId,
          executionId: typeof payload.executionId === 'string' ? payload.executionId : source.executionId,
          correlationId: source.correlationId ?? source.messageId,
          causationId: source.messageId,
          payload,
        }))
      },
      // Etapa 6: resume de tarefa bloqueada reemite TASK_BLOCKED → Monitor-Resolvedor.
      publishTaskBlocked: async (source, reason) => {
        if (!outboxPublisher) throw new Error('Outbox indisponível para TASK_BLOCKED')
        const blocker = await loadActiveBlocker(pool, source.taskId)
        if (!blocker) return
        await outboxPublisher.enqueue(createTaskBlockedMessage({
          taskId: source.taskId,
          executionId: `${source.executionId}-resume-block-${blocker.id}`,
          correlationId: source.correlationId ?? source.messageId,
          causationId: source.messageId,
          payload: {
            blockReason: blocker.block_reason,
            blockCommand: blocker.block_command,
            blockExcerpt: blocker.block_excerpt != null ? String(blocker.block_excerpt) : null,
            subtaskId: blocker.subtarefa_id != null ? Number(blocker.subtarefa_id) : null,
            blockId: Number(blocker.id),
            databaseTaskId: Number(blocker.tarefa_id),
            resumeReason: reason,
          },
        }))
      },
    })
    const developmentRepository = new MySqlDevelopmentExecutionRepository(pool)
    const testGateService = new TestGateService(pool)
    const testGate = new TestGateOrchestrator(pool, gateQueue)
    deployConsumer = new DeployConsumer(
      new DeployRepository(pool, process.env.MOTOR_WORKTREE_ROOT || '/data/workspace/projects/agentes/gerenteagentes/worktrees'),
      testGate,
      new RemoteBlueGreenDeployer(),
      operationLogger,
      new MySqlCommandPolicyRepository(pool),
    )
    const gateTransport = new RabbitMqTransport({
      url: rabbitUrl, exchange: process.env.MOTOR_RABBITMQ_EXCHANGE || 'motor', prefetch: 1,
      queue: gateQueue, retryQueue: `${gateQueue}.retry`, deadLetterQueue: `${gateQueue}.dlq`,
      retryDelayMs: Number(process.env.MOTOR_RABBITMQ_RETRY_DELAY_MS || 30000),
    })
    testGateOutboxPublisher = new OutboxPublisher(pool, gateTransport, gateQueue, gateQueue)
    await testGateOutboxPublisher.start()
    const testGateConsumer = new TestGateConsumer(pool, testGateService, operationLogger, mainQueue)
    testGateQueueConsumer = new QueueConsumer(gateTransport, message => testGateConsumer.handle(message), {
      queue: gateQueue, maxAttempts: Number(process.env.MOTOR_QUEUE_MAX_ATTEMPTS || 3),
    }, pool)
    await testGateQueueConsumer.start()
    // Jobs de gate órfãos (worker morto com job em processing/pending) travam o
    // isMotorIdle() para sempre; o reconciliador reenfileira TEST_RUN_REQUESTED
    // no boot e periodicamente (claim SQL do consumer garante idempotência).
    testGateJobReconciler = new TestGateJobReconciler(pool, {
      enqueue: async message => {
        if (!testGateOutboxPublisher) throw new Error('Outbox de gates indisponível para recuperação')
        await testGateOutboxPublisher.enqueue(message)
      },
      staleMinutes: Number(process.env.MOTOR_TEST_GATE_STALE_MINUTES || 20),
      intervalMs: Number(process.env.MOTOR_TEST_GATE_RECOVERY_INTERVAL_MS || 300000),
    })
    await testGateJobReconciler.reconcile()
    testGateJobReconciler.start()
    developmentConsumer = new DevelopmentExecutionConsumer(
      developmentRepository,
      operationLogger,
    )
    const worktreePreparer = new GitWorktreePreparer(process.env.MOTOR_WORKTREE_ROOT || '/data/workspace/projects/agentes/gerenteagentes/worktrees')
    const environmentPreparer = new WorkspaceEnvironmentPreparer()
    const monitorWorker = new WorkerLauncher({
      maxAttempts: Number(process.env.MOTOR_MONITOR_MAX_ATTEMPTS || 2),
      timeoutMs: Number(process.env.MOTOR_WORKER_TIMEOUT_MS || 1800000),
      sandboxRoot: process.env.MOTOR_WORKTREE_ROOT || '/data/workspace/projects/agentes/gerenteagentes/worktrees',
    })
    const baselineRecovery = new BaselinePreflightRecovery(
      pool, monitorWorker, new WorkerConsoleAdapter(consoleApi), db, testGate,
    )
    subtaskExecutionConsumer = new SubtaskExecutionConsumer(
      developmentRepository,
      worktreePreparer,
      new WorkerLauncher({
        maxAttempts: Number(process.env.MOTOR_WORKER_MAX_ATTEMPTS || 3),
        timeoutMs: Number(process.env.MOTOR_WORKER_TIMEOUT_MS || 1800000),
        sandboxRoot: process.env.MOTOR_WORKTREE_ROOT || '/data/workspace/projects/agentes/gerenteagentes/worktrees',
      }),
      new WorkerConsoleAdapter(consoleApi),
      db,
      operationLogger,
      testGate,
      environmentPreparer,
      baselineRecovery,
    )
    subtaskVerificationConsumer = new SubtaskVerificationConsumer(
      developmentRepository,
      new GitVerificationIntegrator(worktreePreparer),
      operationLogger,
    )
    testRecoveryConsumer = new TestRecoveryConsumer(
      pool, worktreePreparer,
      monitorWorker,
      new WorkerConsoleAdapter(consoleApi), db, testGate,
    )
    // Monitor-Resolvedor de bloqueios (docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md):
    // missão longa (pode corrigir o motor, mergear na base e rodar deploy) —
    // launcher dedicado com timeout maior que o do monitor de testes.
    const monitorResolutionWorker = new WorkerLauncher({
      maxAttempts: Number(process.env.MOTOR_MONITOR_RESOLUTION_MAX_ATTEMPTS || 2),
      timeoutMs: Number(process.env.MOTOR_MONITOR_RESOLUTION_TIMEOUT_MS || 3600000),
      sandboxRoot: process.env.MOTOR_WORKTREE_ROOT || '/data/workspace/projects/agentes/gerenteagentes/worktrees',
    })
    monitorResolutionConsumer = new MonitorResolutionConsumer(
      pool, worktreePreparer, monitorResolutionWorker, new MonitorPromptResolver(pool),
      taskEvents, new WorkerConsoleAdapter(consoleApi), db, new ConsoleHumanNotifier(),
    )
    taskUnblockedConsumer = new TaskUnblockedConsumer(pool, taskEvents)

    cancelConsumer = new TaskCancelConsumer(pool, operationLogger, new MySqlCommandPolicyRepository(pool), taskEvents)
    queueConsumer = new QueueConsumer(transport, async message => {
      await coordinator.handle(message)
      await cancelConsumer?.handle(message)
      await developmentConsumer?.handle(message)
      await subtaskExecutionConsumer?.handle(message)
      await subtaskVerificationConsumer?.handle(message)
      await testRecoveryConsumer?.handle(message)
      await monitorResolutionConsumer?.handle(message)
      await taskUnblockedConsumer?.handle(message)
      await deployConsumer?.handle(message)
    }, {
      queue: process.env.MOTOR_RABBITMQ_QUEUE || 'motor.commands',
      maxAttempts: Number(process.env.MOTOR_QUEUE_MAX_ATTEMPTS || 3),
    }, pool)
    // Claims sem sessão auditada não são recuperáveis e podem ser liberados.
    // Sessões existentes ficam sob o reconciliador abaixo, na mesma chave.
    const orphanClaims = await new AnalysisClaimReconciler(pool).reconcile()
    for (const orphan of orphanClaims) {
      console.warn(`[Motor v3] Claim de análise órfão liberado no boot: task=${orphan.taskExternalId ?? orphan.tarefaId} execution=${orphan.analysisExecutionId ?? '(sem id)'} desde ${orphan.analysisStartedAt}`)
    }
    analysisSessionRecovery = new AnalysisSessionRecoveryReconciler(pool, repository, analyst, consoleApi, {
      taskEvents,
      intervalMs: Number(process.env.MOTOR_ANALYSIS_RECOVERY_INTERVAL_MS || 300000),
      leaseTtlMs: Number(process.env.MOTOR_ANALYSIS_LEASE_TTL_MS || 90000),
      publishTaskReady: async (taskId, executionId, subtaskCount) => {
        if (!outboxPublisher) throw new Error('Outbox indisponível para recuperação de análise')
        await outboxPublisher.enqueue(createQueueMessage({
          type: 'TASK_READY_FOR_PROGRAMMING', taskId, executionId,
          payload: { executionId, recovered: true, subtaskCount },
        }))
      },
    })
    // A primeira passagem termina antes de abrir consumidores; depois disso
    // o timer cobre quedas de dependências externas sem criar nova análise.
    await analysisSessionRecovery.reconcile()
    analysisSessionRecovery.start()
    await queueConsumer.start()
    // Recuperação única de fatos duráveis após boot. O fluxo normal avança
    // exclusivamente por mensagens/eventos; não há timer de deploy.
    await deployConsumer.recoverPendingWork()
    await deployConsumer.requestReconciliation()
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

      // Diagnóstico somente de leitura; a execução continua exclusivamente
      // orientada por mensagens duráveis.
      if (path === '/api/motor/deploy-diagnostics' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await getDeployDiagnostics(pool)))
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
      // Assíncrono via comando durável: 202 accepted é o contrato honesto
      // (item 5 da auditoria do incidente 862). O fato persistido (paused_at)
      // continua sendo gravado pela Biblioteca antes do evento de auditoria.
      if (req.method === 'POST' && taskId && taskAction === 'pause') {
        console.log(`[Motor v3] Task ${taskId} pause requested`)
        const message = await dispatchCommand('TASK_PAUSE_REQUESTED', taskId, taskId, {})
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true, taskId, messageId: message.messageId }))
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
      // Assíncrono via comando durável C04 (consumidor TaskCancelConsumer):
      // 202 accepted reflete que o cancelamento foi ACEITO para processamento,
      // não que o fato já foi persistido (item 5 da auditoria do incidente 862).
      if (req.method === 'POST' && taskId && taskAction === 'cancel') {
        let cancelBody = ''
        req.on('data', chunk => cancelBody += chunk)
        await new Promise(resolve => req.on('end', resolve))
        const cancelPayload = cancelBody ? JSON.parse(cancelBody) : {}
        const ator = typeof cancelPayload.ator === 'string' ? cancelPayload.ator.slice(0, 255) : undefined
        const motivo = typeof cancelPayload.motivo === 'string' ? cancelPayload.motivo.slice(0, 500) : undefined
        console.log(`[Motor v3] Task ${taskId} cancel requested`)
        const message = await dispatchCommand('TASK_CANCEL_REQUESTED', taskId, taskId, { ator, motivo })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true, taskId, messageId: message.messageId }))
        return
      }

      // POST /api/motor/task/:id/deploy. A API só registra a intenção no
      // outbox; gate, Git, SSH e blue-green são processados pelo consumidor.
      if (req.method === 'POST' && taskId && taskAction === 'deploy') {
        const executionId = `deploy-request-${taskId}-${Date.now()}`
        const message = await dispatchCommand('DEPLOY_REQUESTED', taskId, executionId, {})
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true, taskId, executionId, messageId: message.messageId }))
        return
      }

      // POST /api/motor/task/:id/external-resolution — camada C do invariante
      // de conclusão (incidente da tarefa 820): resolução externa governada de
      // bloqueios, com verificação opcional de subtarefa e reconciliação da
      // conclusão na mesma transação. Substitui SQL manual nas tabelas do motor.
      if (req.method === 'POST' && taskId && taskAction === 'external-resolution') {
        let body = ''
        req.on('data', chunk => body += chunk)
        await new Promise(resolve => req.on('end', resolve))
        let payload: any = {}
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }))
          return
        }
        try {
          const result = await externalResolutionHandler.handle({
            taskId,
            motivo: payload.motivo,
            resolvedBy: payload.resolvedBy,
            blockIds: Array.isArray(payload.blockIds) ? payload.blockIds : undefined,
            subtaskId: payload.subtaskId != null ? Number(payload.subtaskId) : undefined,
            requestDeploy: payload.requestDeploy === true,
          })
          console.log(`[Motor v3] External resolution task=${taskId}:`, JSON.stringify(result).slice(0, 300))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          if (error instanceof ExternalResolutionError) {
            const statusCode = error.code === 'not_found' ? 404 : error.code === 'subtask_not_found' ? 404 : 400
            res.writeHead(statusCode, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, code: error.code, error: error.message }))
            return
          }
          throw error
        }
        return
      }

      // POST /api/motor/task/:id/sanitize-session. Arquiva a sessão física
      // do agente sem apagar auditoria; prepara contexto limpo para retomada.
      if (req.method === 'POST' && taskId && taskAction === 'sanitize-session') {
        const [taskRows] = await pool.query<any[]>(
          `SELECT t.id, t.external_id, f.analysis_execution_id
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
        // Por enquanto apenas registra o evento; a implementação completa
        // arquivaria a sessão no Console OpenClaw via API.
        console.log(`[Motor v3] Session sanitize requested for task ${taskId}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessionsArchived: 0, message: 'Sessão arquivada (implementação pendente)' }))
        return
      }

      const deployResultMatch = path.match(/^\/api\/motor\/deploy\/batches\/([^/]+)\/result$/)
      if (req.method === 'POST' && deployResultMatch) {
        const callbackToken = process.env.MOTOR_DEPLOY_CALLBACK_TOKEN
        const provided = String(req.headers['x-motor-deploy-token'] ?? '')
        if (!callbackToken || provided.length !== callbackToken.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(callbackToken))) {
          res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return
        }
        let body = ''
        req.on('data', chunk => body += chunk)
        await new Promise(resolve => req.on('end', resolve))
        const payload = body ? JSON.parse(body) : {}
        const status = payload.status === 'success' ? 'success' : payload.status === 'failed' ? 'failed' : null
        if (!status) throw new Error('Resultado de deploy inválido')
        const batchId = deployResultMatch[1]!
        if (!/^[A-Za-z0-9_-]+$/.test(batchId)) throw new Error('Identificador de lote inválido')
        const message = await dispatchCommand('DEPLOY_BATCH_RESULT_RECEIVED', 'system', `deploy-result-${batchId}`, { batchId, status })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true, messageId: message.messageId }))
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

  if (testGateQueueConsumer) await testGateQueueConsumer.stop()

  if (outboxPublisher) {
    await outboxPublisher.stop()
    console.log('[Motor v3] OutboxPublisher parado')
  }
  testGateJobReconciler?.stop()
  if (testGateOutboxPublisher) await testGateOutboxPublisher.stop()

  // Para scheduler
  if (scheduler) {
    scheduler.stop()
    console.log('[Motor v3] Scheduler parado')
  }
  analysisSessionRecovery?.stop()

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
