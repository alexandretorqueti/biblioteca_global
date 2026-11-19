import { describe, expect, it, vi } from 'vitest'
import { QueueLeadership } from '../src/queue/QueueLeadership.js'

function poolFor(holderId: string) {
  const query = vi.fn()
    .mockResolvedValueOnce([[], {}])
    .mockResolvedValue([ [{ holder_id: holderId }], {} ])
  return { query } as any
}

describe('QueueLeadership', () => {
  it('adquire atomicamente e não considera líder uma instância concorrente', async () => {
    const acquired = vi.fn()
    const first = poolFor('instance-a')
    const leader = new QueueLeadership(first, { instanceId: 'instance-a', onAcquired: acquired })
    await leader.start()
    expect(leader.isLeader()).toBe(true)
    expect(acquired).toHaveBeenCalledOnce()
    await leader.release()

    const second = poolFor('instance-a')
    const standby = new QueueLeadership(second, { instanceId: 'instance-b' })
    await standby.start()
    expect(standby.isLeader()).toBe(false)
    await standby.release()
  })

  it('renova no polling, assume após expiração e libera somente o próprio holder', async () => {
    vi.useFakeTimers()
    const pool = poolFor('instance-a')
    const lost = vi.fn()
    const leadership = new QueueLeadership(pool, {
      instanceId: 'instance-a', leaseTtlMs: 3000, pollMs: 1000, onLost: lost,
    })
    await leadership.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pool.query).toHaveBeenCalledTimes(4)
    await leadership.release()
    expect(pool.query.mock.calls.at(-1)?.[0]).toContain('holder_id = ?')
    expect(lost).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('assume a liderança quando o holder anterior deixa o lease expirar', async () => {
    vi.useFakeTimers()
    let holder = 'dead-instance'
    const pool = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT holder_id')) return [[{ holder_id: holder }], {}]
      return [[], {}]
    }) } as any
    const acquired = vi.fn()
    const leadership = new QueueLeadership(pool, {
      instanceId: 'instance-b', pollMs: 1000, onAcquired: acquired,
    })
    await leadership.start()
    expect(leadership.isLeader()).toBe(false)
    holder = 'instance-b'
    await vi.advanceTimersByTimeAsync(1000)
    expect(leadership.isLeader()).toBe(true)
    expect(acquired).toHaveBeenCalledOnce()
    await leadership.release()
    vi.useRealTimers()
  })
})
