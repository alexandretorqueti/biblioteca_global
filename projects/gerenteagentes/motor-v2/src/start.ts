#!/usr/bin/env node
/**
 * Motor v2 - Script de inicialização
 */

import { Motor } from './Motor.js'
import { createDbConnection, MysqlTaskRepository } from './database/DrizzleDb.js'
import { LibraryRealtimeBroadcaster } from './events/LibraryRealtimeBroadcaster.js'

async function main() {
  console.log('🚀 Motor v2 - Iniciando...')

  // Conecta ao banco real
  console.log('📦 Conectando ao banco de dados...')
  const { db } = await createDbConnection()
  const repository = new MysqlTaskRepository(db)
  console.log('✅ Banco conectado')

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
    console.log(`\n🛑 ${signal}`)
    await motor.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await motor.start()
    console.log(`✅ Motor v2 rodando em http://localhost:${apiPort}`)
    console.log('   GET /api/motor/health')
    console.log('   GET /api/motor/stats')
    console.log('   POST /api/motor/pump')
  } catch (error) {
    console.error('❌ Erro:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Fatal:', error)
  process.exit(1)
})
