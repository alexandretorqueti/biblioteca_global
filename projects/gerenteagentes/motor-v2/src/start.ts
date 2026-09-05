#!/usr/bin/env node
/**
 * Motor v2 - Script de inicialização
 */

import { Motor } from './Motor.js'
import { createDbConnection, MysqlTaskRepository } from './database/DrizzleDb.js'
import { LibraryRealtimeBroadcaster } from './events/LibraryRealtimeBroadcaster.js'
import { createLogger } from './shared/logger.js'

const logger = createLogger('MotorStart')

async function main() {
  logger.info('🚀 Motor v2 - Iniciando...')

  // Conecta ao banco real
  logger.info('📦 Conectando ao banco de dados...')
  const { db } = await createDbConnection()
  const repository = new MysqlTaskRepository(db)
  logger.info('✅ Banco conectado')

  const realtimeToken = process.env.LIBRARY_REALTIME_EVENTS_TOKEN
  const activityBroadcaster = realtimeToken
    ? new LibraryRealtimeBroadcaster({
        db,
        token: realtimeToken,
        endpoint: process.env.LIBRARY_REALTIME_EVENTS_URL ?? 'http://localhost:3001/internal/realtime/events',
      })
    : undefined

  const apiPort = Number(process.env.MOTOR_API_PORT ?? 3010)
  const motor = new Motor({
    db,
    repository,
    maxWorkers: Number(process.env.MOTOR_MAX_WORKERS ?? 1),
    apiPort,
    reconcilerIntervalMs: 30000,
    activityBroadcaster,
  })

  const shutdown = async (signal: string) => {
    logger.info(`🛑 ${signal}`)
    await motor.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown('SIGINT').catch((err) => logger.error('Erro no shutdown SIGINT: ' + (err instanceof Error ? err.stack ?? err.message : String(err)))) })
  process.on('SIGTERM', () => { void shutdown('SIGTERM').catch((err) => logger.error('Erro no shutdown SIGTERM: ' + (err instanceof Error ? err.stack ?? err.message : String(err)))) })

  // Última linha de defesa contra unhandled rejections.
  // Sem isso, Node.js ≥15 mata o processo silenciosamente em qualquer promise
  // rejeitada sem catch — incluindo event handlers async do EventEmitter.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('⚠️ Unhandled Rejection: ' + (reason instanceof Error ? reason.stack ?? reason.message : String(reason)))
  })
  process.on('uncaughtException', (error: Error) => {
    logger.error('💥 Uncaught Exception: ' + (error.stack ?? error.message))
    process.exit(1)
  })

  try {
    await motor.start()
    logger.info(`✅ Motor v2 rodando em http://localhost:${apiPort}`)
    logger.info('   GET /api/motor/health')
    logger.info('   GET /api/motor/stats')
    logger.info('   POST /api/motor/pump')
  } catch (error) {
    logger.error('❌ Erro: ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
    process.exit(1)
  }
}

main().catch((error) => {
  logger.error('❌ Fatal: ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exit(1)
})

