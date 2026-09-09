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
import { getConfigNumber } from './config/MotorConfigReader.js'

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

  constructor(config: MotorConfig) {
    // Usa valores explícitos se fornecidos, senão busca do config reader (com fallback para defaults)
    const maxWorkers = config.maxWorkers ?? getConfigNumber('motor.max_workers')
    const maxWorkersPerProject = config.maxWorkersPerProject ?? getConfigNumber('motor.max_workers_per_project')
    const apiPort = config.apiPort ?? 3010

    // Configurações de recursos — lê do config reader com fallback para defaults
    const defaultLeaseMs = getConfigNumber('motor.resource_lease_ms')
    const heartbeatIntervalMs = getConfigNumber('motor.resource_heartbeat_interval_ms')

    this.resourceLease = new ResourceLeaseService({ 
      db: config.db,
      defaultLeaseMs,
      heartbeatIntervalMs,
    })
    this._waitManager = new ResourceWaitManager(config.db, config.repository)
    this.workerLauncher = new WorkerLauncher()
    this.reconciler = new ExpirationReconciler({
      db: config.db,
      intervalMs: config.reconcilerIntervalMs ?? getConfigNumber('motor.reconciler_interval_ms'),
      onLeaseExpired: (resourceKey, executionId) => this.coordinator.onLeaseExpired(resourceKey, executionId),
    })
    this.coordinator = new TaskCoordinator(config.db, config.repository, this.resourceLease, {
      maxWorkers,
      maxWorkersPerProject,
    }, this.workerLauncher, undefined, this._waitManager)
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

    // Intervalo de pump configurável
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
