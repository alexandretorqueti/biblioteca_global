/**
 * Serviço que inicializa o motor-v2 dentro do container da API.
 * O motor-v2 roda como processo interno (não container separado).
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDbConnection, MysqlTaskRepository } from '@biblioteca-global/motor-v2/database'
import { Motor } from '@biblioteca-global/motor-v2/Motor'
import { TaskCoordinator } from '@biblioteca-global/motor-v2/coordinator/TaskCoordinator'
import { ExpirationReconciler } from '@biblioteca-global/motor-v2/reconciler/ExpirationReconciler'
import { MotorAPI } from '@biblioteca-global/motor-v2/api/MotorAPI'
import { WorkerLauncher } from '@biblioteca-global/motor-v2/workers/WorkerLauncher'
import type { Db, TaskRepository } from '@biblioteca-global/motor-v2/shared/types'

@Injectable()
export class MotorV2Service implements OnModuleInit, OnModuleDestroy {
  private motor: Motor | null = null
  private db: Db | null = null

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    const motorVersion = this.config.get('MOTOR_VERSION', 'v1')
    if (motorVersion !== 'v2') {
      console.log('[MotorV2Service] MOTOR_VERSION não é v2, motor-v2 não será iniciado')
      return
    }

    console.log('[MotorV2Service] Iniciando motor-v2...')

    // Conecta ao banco
    const { db, connection } = await createDbConnection({
      host: this.config.get('MYSQL_HOST', 'mysql'),
      port: Number(this.config.get('MYSQL_PORT', 3306)),
      user: this.config.get('MYSQL_USER', 'biblioteca'),
      password: this.config.get('MYSQL_PASSWORD', ''),
      database: this.config.get('MYSQL_DATABASE', 'projeto_640'),
    })
    this.db = db

    // Cria repositório
    const repo: TaskRepository = new MysqlTaskRepository(db)

    // Cria launcher de workers
    const workerLauncher = new WorkerLauncher({
      maxWorkers: Number(this.config.get('MOTOR_MAX_WORKERS', 1)),
      workerScript: require.resolve('@biblioteca-global/motor-v2/workers/TaskWorker'),
    })

    // Cria coordenador
    const coordinator = new TaskCoordinator({
      repo,
      workerLauncher,
      lockTtlMs: 60_000,
      heartbeatIntervalMs: 10_000,
    })

    // Cria reconciliador
    const reconciler = new ExpirationReconciler({
      repo,
      intervalMs: 30_000,
    })

    // Cria API HTTP
    const apiPort = Number(this.config.get('MOTOR_API_PORT', 3010))
    const api = new MotorAPI({
      port: apiPort,
      coordinator,
      reconciler,
    })

    // Cria motor
    this.motor = new Motor({
      coordinator,
      reconciler,
      api,
    })

    // Inicia
    await this.motor.start()
    console.log(`[MotorV2Service] Motor-v2 iniciado na porta ${apiPort}`)
  }

  async onModuleDestroy() {
    if (this.motor) {
      await this.motor.stop()
      console.log('[MotorV2Service] Motor-v2 parado')
    }
    if (this.db) {
      await this.db.close()
      console.log('[MotorV2Service] Conexão DB fechada')
    }
  }
}
