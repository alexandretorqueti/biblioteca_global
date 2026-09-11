/**
 * Motor v2 - Entry point principal
 */

import type { Db, TaskRepository } from './shared/types/infrastructure.js'
import { TaskCoordinator } from './coordinator/TaskCoordinator.js'
import { ResourceLeaseService } from './resources/ResourceLeaseService.js'
import { ResourceWaitManager } from './resources/ResourceWaitManager.js'
import { WorkerLauncher } from './workers/WorkerLauncher.js'
import { ExpirationReconciler } from './reconciler/ExpirationReconciler.js'
import { MotorAPI } from './api/MotorAPI.js'
import { resourceEventBus } from './resources/ResourceEventBus.js'
import { executionEventBus, type ExecutionActivityBroadcaster } from './events/ExecutionEventBus.js'
import { createLogger, describeError } from './shared/logger.js'
import { getConfigNumber, getConfigString } from './config/MotorConfigReader.js'
import { ConsoleAgentRuntimeDriver } from './runtime/ConsoleAgentRuntimeDriver.js'
import { PromotionConflictAnalyzer } from './promotion-conflicts/PromotionConflictAnalyzer.js'
import { PromotionConflictEvidenceCollector } from './promotion-conflicts/PromotionConflictEvidenceCollector.js'
import { PromotionConflictOrchestrator } from './promotion-conflicts/PromotionConflictOrchestrator.js'
import { PromotionConflictRepository } from './promotion-conflicts/PromotionConflictRepository.js'
import { PromotionConflictResolver } from './promotion-conflicts/PromotionConflictResolver.js'
import { PromotionRetryRepository } from './promotion-retries/PromotionRetryRepository.js'
import { PromotionRetryOrchestrator } from './promotion-retries/PromotionRetryOrchestrator.js'
import { PromotionGateRecoveryOrchestrator } from './promotion-gate/PromotionGateRecoveryOrchestrator.js'

export interface MotorConfig {
  db: Db
  repository: TaskRepository
  maxWorkers?: number
  maxWorkersPerProject?: number
  apiPort?: number
  reconcilerIntervalMs?: number
  activityBroadcaster?: ExecutionActivityBroadcaster
}

export class Motor {
  private logger = createLogger('Motor')
  private coordinator: TaskCoordinator
  private resourceLease: ResourceLeaseService
  private _waitManager: ResourceWaitManager
  private workerLauncher: WorkerLauncher
  private reconciler: ExpirationReconciler
  private api: MotorAPI
  private pumpInterval: ReturnType<typeof setInterval> | null = null
  private consoleDriver: ConsoleAgentRuntimeDriver

  constructor(config: MotorConfig) {
    const apiPort = config.apiPort ?? 3010

    const defaultLeaseMs = getConfigNumber('motor.resource_lease_ms')
    const heartbeatIntervalMs = getConfigNumber('motor.resource_heartbeat_interval_ms')

    // Driver do Console OpenClaw para consultar sessões ativas
    // Workers usam as variáveis de ambiente injetadas pelo container. O Motor
    // principal deve usar a mesma rota; uma configuração antiga no banco não
    // pode desviar somente o Monitor para um Console inacessível.
    const consoleUrl = process.env.OPENCLAW_CONSOLE_URL || getConfigString('motor.console_url') || 'http://127.0.0.1:6280'
    const consoleToken = process.env.OPENCLAW_CONSOLE_TOKEN || getConfigString('motor.console_token') || ''
    this.consoleDriver = new ConsoleAgentRuntimeDriver({
      baseUrl: consoleUrl,
      token: consoleToken,
    })

    this.resourceLease = new ResourceLeaseService({ 
      db: config.db,
      defaultLeaseMs,
      heartbeatIntervalMs,
    })
    this._waitManager = new ResourceWaitManager(config.db, config.repository)
    this.workerLauncher = new WorkerLauncher()
    const promotionConflictOrchestrator = new PromotionConflictOrchestrator(
      new PromotionConflictRepository(config.db),
      new PromotionConflictEvidenceCollector(),
      new PromotionConflictAnalyzer(this.consoleDriver),
      new PromotionConflictResolver(this.consoleDriver),
      // O callback só roda depois do construtor terminar, quando o
      // coordenador já existe. Assim o módulo de conflitos não depende dele.
      { promote: (candidate, resolutionBranch) => this.coordinator.promote(candidate, resolutionBranch) },
    )
    const promotionRetryOrchestrator = new PromotionRetryOrchestrator(
      new PromotionRetryRepository(config.db),
      { retry: (candidate) => this.coordinator.retry(candidate) },
    )
    const promotionGateRecoveryOrchestrator = new PromotionGateRecoveryOrchestrator(config.db, {
      recoverPromotionGate: (candidate, report) => this.coordinator.recoverPromotionGate(candidate, report),
      releaseStalePromotionBlocker: (taskId) => this.coordinator.releaseStalePromotionBlocker(taskId),
    })
    this.reconciler = new ExpirationReconciler({
      db: config.db,
      intervalMs: config.reconcilerIntervalMs ?? getConfigNumber('motor.reconciler_interval_ms'),
      consoleDriver: this.consoleDriver,
      onLeaseExpired: (resourceKey, executionId) => this.coordinator.onLeaseExpired(resourceKey, executionId),
    })
    // maxWorkers e maxWorkersPerProject são lidos dinamicamente pelo TaskCoordinator
    // via getConfigNumber, permitindo alteração em runtime sem restart
    this.coordinator = new TaskCoordinator(config.db, config.repository, this.resourceLease, {
      maxWorkers: config.maxWorkers,
      maxWorkersPerProject: config.maxWorkersPerProject,
    }, this.workerLauncher, undefined, this._waitManager, undefined, promotionConflictOrchestrator, promotionRetryOrchestrator, promotionGateRecoveryOrchestrator)
    this.api = new MotorAPI({ port: apiPort, coordinator: this.coordinator, db: config.db })

    this.setupEventHandlers()
    if (config.activityBroadcaster) {
      executionEventBus.on((event) => {
        void Promise.resolve(config.activityBroadcaster!.publish(event)).catch((error: unknown) => {
          this.logger.error('Falha ao publicar atividade realtime: ' + describeError(error))
        })
      })
    }
  }

  async start(): Promise<void> {
    this.logger.info('Iniciando motor-v2...')
    this.reconciler.start()
    await this.api.start()

    const pumpIntervalMs = getConfigNumber('motor.pump_interval_ms')
    this.pumpInterval = setInterval(() => {
      this.coordinator.pump().catch((err: Error) => this.logger.error('Erro no pump: ' + describeError(err)))
    }, pumpIntervalMs)

    await this.coordinator.pump()
    this.logger.info('Motor-v2 iniciado (pump a cada ' + pumpIntervalMs + 'ms)')
  }

  async stop(): Promise<void> {
    this.logger.info('Parando...')
    if (this.pumpInterval) { clearInterval(this.pumpInterval); this.pumpInterval = null }
    this.reconciler.stop()
    await this.workerLauncher.shutdownAll()
    await this.api.stop()
    this.logger.info('Parado')
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on('worker_exit', (event: { executionId: string; code: number | null }) => {
      this.logger.info(`Worker exit: ${event.executionId} (code: ${event.code})`, { executionId: event.executionId })
    })
    resourceEventBus.on('released', (event) => {
      this.coordinator.onResourceReleased(event.resourceKey).catch((err: unknown) => {
        this.logger.error('Erro ao processar resource released: ' + describeError(err), { resourceKey: event.resourceKey })
      })
    })
  }

  getCoordinator(): TaskCoordinator { return this.coordinator }
  getResourceLease(): ResourceLeaseService { return this.resourceLease }
}
