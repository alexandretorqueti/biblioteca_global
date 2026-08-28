#!/usr/bin/env node
/**
 * Motor v2 - Script de inicialização
 * 
 * Uso: npm start
 * 
 * Inicializa o motor com configurações padrão
 */

import { Motor } from './Motor.js'

// TODO: Inicializar db e repository reais
// Por enquanto, usa mocks para teste de inicialização

async function main() {
  console.log('🚀 Motor v2 - Iniciando...')

  // Mock db e repository para teste
  const mockDb = {
    query: async () => ({ rows: [], affectedRows: 0, insertId: 0 }),
    transaction: async (fn) => fn(mockDb),
  }

  const mockRepository = {
    saveTask: async () => {},
    getTask: async () => null,
  }

  const motor = new Motor({
    db: mockDb as any,
    repository: mockRepository as any,
    maxWorkers: 1,
    apiPort: 3010,
    reconcilerIntervalMs: 30000,
  })

  // Handler de shutdown gracioso
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 ${signal} recebido, parando motor...`)
    await motor.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await motor.start()
    console.log('✅ Motor v2 rodando na porta 3010')
    console.log('📊 Health check: http://localhost:3010/api/motor/health')
    console.log('📈 Stats: http://localhost:3010/api/motor/stats')
  } catch (error) {
    console.error('❌ Erro ao iniciar motor:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Erro fatal:', error)
  process.exit(1)
})
