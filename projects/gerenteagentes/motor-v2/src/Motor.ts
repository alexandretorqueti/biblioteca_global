/**
 * Motor v2 - Entry point principal
 * 
 * Integra todos os componentes:
 * - TaskCoordinator (scheduler)
 * - ResourceLeaseService (locks)
 * - WorkerLauncher (processos filhos)
 * - ExpirationReconciler (reconciliação)
 * - MotorAPI (endpoints REST)
 */

import type { Db, TaskRepository } from '@gerente-agentes/persistence'
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
  private waitManager: ResourceWaitManager
  private workerLauncher: WorkerLauncher
  private reconciler: ExpirationReconciler
  private api: MotorAPI
  private pumpInterval: NodeJS.Timeout | null = null

  constructor(config: MotorConfig) {
    const maxWorkers = config.maxWorkers ?? 1
    const apiPort = config.apiPort ?? 3010

    // Inicializa componentes
    this.resourceLease = new ResourceLeaseService({ db: config.db })
    this.waitManager = new ResourceWaitManager(config.db, config.repository)
    this.workerLauncher = new WorkerLauncher()
    this.reconciler = new ExpirationReconciler({
      db: config.db,
      intervalMs: config.reconcilerIntervalMs,
    })

    this.coordinator = new TaskCoordinator(
      config.db,
      config.repository,
      this.resourceLease,
      { maxWorkers }
    )

    this.api = new MotorAPI({
      port: apiPort,
      coordinator: this.coordinator,
    })

    this.setupEventHandlers()
  }

  /**
   * Inicia todos os componentes
   */
  async start(): Promise<void> {
    console.log('[Motor] Iniciando motor-v2...')

    // 1. Inicia reconciliador
    this.reconciler.start()

    // 2. Inicia API
    await this.api.start()

    // 3. Inicia pump periódico (a cada 30s)
    this.pumpInterval = setInterval(async () => {
      try {
        await this.coordinator.pump()
      } catch (error) {
        console.error('[Motor] Erro durante pump:', error)
      }
    }, 30000)

    // 4. Pump inicial
    await this.coordinator.pump()

    console.log('[Motor] Motor-v2 iniciado com sucesso')
  }

  /**
   * Para todos os componentes
   */
  async stop(): Promise<void> {
    console.log('[Motor] Parando motor-v2...')

    // 1. Para pump periódico
    if (this.pumpInterval) {
      clearInterval(this.pumpInterval)
      this.pumpInterval = null
    }

    // 2. Para reconciliador
    this.reconciler.stop()

    // 3. Shutdown workers
    this.workerLauncher.shutdownAll()

    // 4. Para API
    await this.api.stop()

    console.log('[Motor] Motor-v2 parado')
  }

  /**
   * Configura handlers de eventos
   */
  private setupEventHandlers(): void {
    // Worker completou
    this.workerLauncher.on('completed', async (msg) => {
      console.log(`[Motor] Worker completou: ${msg.executionId}`)
      await this.coordinator.onTaskCompleted(msg.executionId)
    })

    // Worker falhou
    this.workerLauncher.on('failed', async (msg) => {
      console.error(`[Motor] Worker falhou: ${msg.executionId}`, msg.error)
      await this.coordinator.onTaskFailed(msg.executionId, msg.error)
    })

    // Worker aguardando recurso
    this.workerLauncher.on('waiting_resource', async (msg) => {
      console.log(`[Motor] Worker aguardando recurso: ${msg.resourceKey}`)
      // TODO: Notificar ResourceWaitManager
    })

    // Worker exit
    this.workerLauncher.on('worker_exit', (event) => {
      console.log(`[Motor] Worker saiu: ${event.executionId} (code: ${event.code})`)
    })
  }

  /**
   * Obtém coordenador (para testes/inspeção)
   */
  getCoordinator(): TaskCoordinator {
    return this.coordinator
  }

  /**
   * Obtém resource lease service (para testes/inspeção)
   */
  getResourceLease(): ResourceLeaseService {
    return this.resourceLease
  }
}
