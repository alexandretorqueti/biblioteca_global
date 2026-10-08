import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RABBITMQ_INITIAL_CONNECT_TIMEOUT_MS,
  MIN_RABBITMQ_PREFETCH,
  normalizeRabbitMqPrefetch,
} from '../src/queue/index.js'

describe('contrato RabbitMQ do Motor v3', () => {
  it('mantém orçamento padrão de boot entre dois e três minutos', () => {
    expect(DEFAULT_RABBITMQ_INITIAL_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
    expect(DEFAULT_RABBITMQ_INITIAL_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(180_000)
  })

  it('impõe prefetch mínimo 4 para zero, negativos e inválidos', () => {
    expect(MIN_RABBITMQ_PREFETCH).toBe(4)
    for (const value of [0, 1, 3, -10, Number.NaN, Number.POSITIVE_INFINITY, 'abc' as unknown as number]) {
      expect(normalizeRabbitMqPrefetch(value)).toBeGreaterThanOrEqual(4)
    }
  })

  it('preserva valores válidos acima do mínimo e trunca frações', () => {
    expect(normalizeRabbitMqPrefetch(4)).toBe(4)
    expect(normalizeRabbitMqPrefetch(8.9)).toBe(8)
    expect(normalizeRabbitMqPrefetch('12')).toBe(12)
  })
})
