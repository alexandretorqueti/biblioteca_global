#!/usr/bin/env node
/**
 * Motor v2 - Script de inicialização
 */

import { Motor } from './Motor.js'
import type { Db, TaskRepository, QueryResult, SaveTaskData } from './shared/types/infrastructure.js'

async function main() {
  console.log('🚀 Motor v2 - Iniciando...')

  // Mock db/repository para teste de inicialização
  const mockDb: Db = {
    query: async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({ rows: [], affectedRows: 0, insertId: 0 }),
    transaction: async <T>(fn: (db: Db) => Promise<T>): Promise<T> => fn(mockDb),
  }

  const mockRepository: TaskRepository = {
    saveTask: async (_data: SaveTaskData): Promise<void> => {},
    getTask: async (_id: string): Promise<SaveTaskData | null> => null,
  }

  const motor = new Motor({
    db: mockDb,
    repository: mockRepository,
    maxWorkers: 1,
    apiPort: 3010,
    reconcilerIntervalMs: 30000,
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
    console.log('✅ Motor v2 rodando em http://localhost:3010')
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
