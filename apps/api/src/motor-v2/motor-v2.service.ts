/**
 * Serviço que inicializa o motor-v2 dentro do container da API.
 * O motor-v2 roda como processo interno (não container separado).
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDbConnection, MysqlTaskRepository } from '../../../../projects/gerenteagentes/motor-v2/src/database/DrizzleDb'
import { Motor } from '../../../../projects/gerenteagentes/motor-v2/src/Motor'
import type { Db } from '../../../../projects/gerenteagentes/motor-v2/src/shared/types'

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
    const repo = new MysqlTaskRepository(db)

    // Cria motor (ele cria coordinator, reconciler, api, workerLauncher internamente)
    this.motor = new Motor({
      db,
      repository: repo,
      maxWorkers: Number(this.config.get('MOTOR_MAX_WORKERS', 1)),
      apiPort: Number(this.config.get('MOTOR_API_PORT', 3010)),
      reconcilerIntervalMs: 30_000,
    })

    // Inicia
    await this.motor.start()
    console.log(`[MotorV2Service] Motor-v2 iniciado`)
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
