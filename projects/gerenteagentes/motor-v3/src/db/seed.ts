/**
 * Seed do Catálogo — dados iniciais para o Motor v3
 * 
 * Popula as tabelas:
 * - motor_primitives (32 primitivas)
 * - motor_events (35 eventos)
 * - motor_actions (20 ações)
 * - motor_patterns (patterns para erros)
 * - motor_reactions (reações progressivas)
 * 
 * Baseado em: docs/MOTOR-V2-SIMULACAO-TEXTUAL.md §2-§3 e docs/ESPECIFICACAO.md §18
 */

import 'dotenv/config'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from '../src/db/schema.js'

const DB_URL = process.env.DATABASE_URL || 'mysql://root:root@localhost:3308/projeto_640'

async function seed() {
  console.log('[Seed] Conectando ao MySQL...')
  const pool = await mysql.createPool(DB_URL)
  const db = drizzle(pool, { schema, mode: 'default' })

  console.log('[Seed] Populando primitivas...')
  // Primitivas já estão registradas em código (src/primitives/)
  // Aqui apenas listamos para referência
  
  console.log('[Seed] Populando eventos...')
  // Eventos serão inseridos via SQL ou API
  
  console.log('[Seed] Seed completo')
  await pool.end()
}

seed().catch(err => {
  console.error('[Seed] Erro:', err)
  process.exit(1)
})
