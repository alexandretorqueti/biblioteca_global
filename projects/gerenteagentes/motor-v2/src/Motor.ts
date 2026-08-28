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

export interface MotorConfig {
  db: Db
  repository: TaskRepository
  maxWorkers?: number
  apiPort?: number
  reconcilerIntervalMs?: number
}

export class Motor {
  private coordinator: TaskCoordinator
  private resourceLease: ResourceLeaseService
  private _waitManager: ResourceWaitManager
  private workerLauncher: WorkerLauncher
  private reconciler: ExpirationReconciler
  private api: MotorAPI
  private pumpInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: MotorConfig) {
    const maxWorkers = config.maxWorkers ?? 1
    const apiPort = config.apiPort ?? 3010

    this.resourceLease = new ResourceLeaseService({ db: config.db })
    this._waitManager = new ResourceWaitManager(config.db, config.repository)
    this.workerLauncher = new WorkerLauncher()
    this.reconciler = new ExpirationReconciler({ db: config.db, intervalMs: config.reconcilerIntervalMs })
    this.coordinator = new TaskCoordinator(config.db, config.repository, this.resourceLease, { maxWorkers })
    this.api = new MotorAPI({ port: apiPort, coordinator: this.coordinator })

    this.setupEventHandlers()
  }

  async start(): Promise<void> {
    console.log('[Motor] Iniciando motor-v2...')
    this.reconciler.start()
    await this.api.start()

    this.pumpInterval = setInterval(() => {
      this.coordinator.pump().catch((err: Error) => console.error('[Motor] Erro no pump:', err))
    }, 30000)

    await this.coordinator.pump()
    console.log('[Motor] Motor-v2 iniciado')
  }

  async stop(): Promise<void> {
    console.log('[Motor] Parando...')
    if (this.pumpInterval) { clearInterval(this.pumpInterval); this.pumpInterval = null }
    this.reconciler.stop()
    this.workerLauncher.shutdownAll()
    await this.api.stop()
    console.log('[Motor] Parado')
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on('completed', async (msg: { executionId: string }) => {
      await this.coordinator.onTaskCompleted(msg.executionId)
    })
    this.workerLauncher.on('failed', async (msg: { executionId: string; error: string }) => {
      await this.coordinator.onTaskFailed(msg.executionId, msg.error)
    })
    this.workerLauncher.on('worker_exit', (event: { executionId: string; code: number | null }) => {
      console.log(`[Motor] Worker exit: ${event.executionId} (code: ${event.code})`)
    })
  }

  getCoordinator(): TaskCoordinator { return this.coordinator }
  getResourceLease(): ResourceLeaseService { return this.resourceLease }
}
