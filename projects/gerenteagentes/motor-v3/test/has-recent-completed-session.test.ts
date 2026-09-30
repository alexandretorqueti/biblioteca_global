import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository } from '../src/execution/DevelopmentExecutionRepository.js'

function makePool(options: { recentCompletedCount?: number } = {}) {
  const recentCompletedCount = options.recentCompletedCount ?? 0

  const queryFn = vi.fn().mockImplementation((sql: string) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()

    if (
      normalizedSql.includes('SELECT COUNT(*) AS total FROM motor_agent_sessions')
      && normalizedSql.includes("status='completed'")
      && normalizedSql.includes("close_reason='development_completed'")
      && normalizedSql.includes('DATE_SUB(NOW(), INTERVAL 10 MINUTE)')
    ) {
      return [[{ total: recentCompletedCount }]]
    }

    return [{}]
  })

  const pool = {
    query: queryFn,
    getConnection: vi.fn(),
    end: vi.fn(),
  }

  return { pool, queries: queryFn.mock.calls }
}

describe('hasRecentCompletedDevelopmentSession', () => {
  it('retorna true quando existe sessão concluída com sucesso nos últimos 10 minutos', async () => {
    const { pool } = makePool({ recentCompletedCount: 1 })
    const repository = new MySqlDevelopmentExecutionRepository(pool as never)

    const result = await repository.hasRecentCompletedDevelopmentSession(901)

    expect(result).toBe(true)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status='completed'"),
      [901]
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("close_reason='development_completed'"),
      [901]
    )
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DATE_SUB(NOW(), INTERVAL 10 MINUTE)'),
      [901]
    )
  })

  it('retorna false quando não existe sessão concluída recentemente', async () => {
    const { pool } = makePool({ recentCompletedCount: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(pool as never)

    const result = await repository.hasRecentCompletedDevelopmentSession(901)

    expect(result).toBe(false)
  })

  it('ignora sessões concluídas por outros motivos', async () => {
    const { pool } = makePool({ recentCompletedCount: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(pool as never)

    const result = await repository.hasRecentCompletedDevelopmentSession(901)

    expect(result).toBe(false)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("close_reason='development_completed'"),
      [901]
    )
  })

  it('usa 10 minutos como janela de proteção', async () => {
    const { pool } = makePool({ recentCompletedCount: 1 })
    const repository = new MySqlDevelopmentExecutionRepository(pool as never)

    await repository.hasRecentCompletedDevelopmentSession(901)

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INTERVAL 10 MINUTE'),
      [901]
    )
  })
})

describe('closeDevelopmentSession', () => {
  it('fecha pela runtime_session_id, pois a chave persistida pode receber prefixo do agente', async () => {
    const { pool } = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(pool as never)

    await repository.closeDevelopmentSession(901, 'runtime-123', 'dev-gpt-task-901-s901', true)

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('runtime_session_id=?'),
      ['completed', 'development_completed', 901, 'runtime-123', 'dev-gpt-task-901-s901', 'dev-gpt-task-901-s901'],
    )
  })
})
