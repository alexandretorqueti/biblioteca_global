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
import { MotorConfigService, setGlobalConfigService, getGlobalConfigService } from './shared/MotorConfigService.js'
import { GitWorkspaceManager } from './workspaces/GitWorkspaceManager.js'

export interface MotorConfig {
  db: Db
  repository: TaskRepository
  maxWorkers?: number
  maxWorkersPerProject?: number
  apiPort?: number
  reconcilerIntervalMs?: number
  activityBroadcaster?: ExecutionActivityBroadcaster
  configService?: MotorConfigService
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
    // Inicializa o serviço de configurações se fornecido
    if (config.configService) {
      setGlobalConfigService(config.configService)
    }

    // Lê configurações do serviço ou usa valores fornecidos/defaults
    const configService = config.configService
    const maxWorkers = config.maxWorkers ?? configService?.getNumber('motor.max_workers', 1) ?? 1
    const maxWorkersPerProject = config.maxWorkersPerProject ?? configService?.getNumber('motor.max_workers_per_project', 1) ?? 1
    const apiPort = config.apiPort ?? 3010
    const reconcilerIntervalMs = config.reconcilerIntervalMs ?? configService?.getNumber('motor.reconciler_interval_ms', 30000) ?? 30000

    // Configurações de recursos
    const resourceLeaseMs = configService?.getNumber('motor.resource_lease_ms', 600000) ?? 600000
    const resourceHeartbeatIntervalMs = configService?.getNumber('motor.resource_heartbeat_interval_ms', 30000) ?? 30000

    this.resourceLease = new ResourceLeaseService({ 
      db: config.db,
      defaultLeaseMs: resourceLeaseMs,
      heartbeatIntervalMs: resourceHeartbeatIntervalMs,
    })
    this._waitManager = new ResourceWaitManager(config.db, config.repository)
    this.workerLauncher = new WorkerLauncher(configService)
    this.reconciler = new ExpirationReconciler({
      db: config.db,
      intervalMs: reconcilerIntervalMs,
      onLeaseExpired: (resourceKey, executionId) => this.coordinator.onLeaseExpired(resourceKey, executionId),
    })
    const workspaceManager = new GitWorkspaceManager({ root: process.env.MOTOR_WORKSPACE_ROOT ?? "/tmp/motor-v2-workspaces" })
    this.coordinator = new TaskCoordinator(config.db, config.repository, this.resourceLease, {
      maxWorkers,
      maxWorkersPerProject,
    }, this.workerLauncher, configService, workspaceManager, this._waitManager)
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

    // Lê o intervalo de pump do serviço de configurações
    const pumpIntervalMs = getGlobalConfigService()?.getNumber('motor.pump_interval_ms', 30000) ?? 30000
    this.pumpInterval = setInterval(() => {
      this.coordinator.pump().catch((err: Error) => this.logger.error('Erro no pump: ' + describeError(err)))
    }, pumpIntervalMs)

    await this.coordinator.pump()
    this.logger.info('Motor-v2 iniciado')
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
