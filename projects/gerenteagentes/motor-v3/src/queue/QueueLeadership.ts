import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface QueueLeadershipConfig {
  key?: string
  instanceId?: string
  leaseTtlMs?: number
  pollMs?: number
  onAcquired?: () => Promise<void> | void
  onLost?: () => Promise<void> | void
}

interface LeadershipRow extends RowDataPacket {
  holder_id: string
}

/** Lease de banco que garante um único conjunto de consumidores duráveis. */
export class QueueLeadership {
  readonly instanceId: string
  private readonly key: string
  private readonly leaseTtlMs: number
  private readonly pollMs: number
  private readonly onAcquired?: () => Promise<void> | void
  private readonly onLost?: () => Promise<void> | void
  private timer: NodeJS.Timeout | null = null
  private leader = false
  private ticking = false

  constructor(private readonly pool: Pool, config: QueueLeadershipConfig = {}) {
    this.key = config.key ?? 'motor-queues'
    this.instanceId = config.instanceId ?? `${randomUUID()}@${hostname()}`
    this.leaseTtlMs = Math.max(3_000, config.leaseTtlMs ?? 30_000)
    this.pollMs = Math.max(1_000, config.pollMs ?? Math.floor(this.leaseTtlMs / 3))
    this.onAcquired = config.onAcquired
    this.onLost = config.onLost
  }

  isLeader(): boolean { return this.leader }

  async tryAcquire(): Promise<boolean> {
    const ttlSeconds = Math.max(1, Math.ceil(this.leaseTtlMs / 1000))
    await this.pool.query(
      `INSERT INTO motor_queue_leadership
         (leadership_key, holder_id, lease_expires_at, acquired_at, updated_at)
       VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND), NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE
         acquired_at = IF(lease_expires_at < NOW(3) OR holder_id = VALUES(holder_id), IF(holder_id = VALUES(holder_id), acquired_at, NOW(3)), acquired_at),
         holder_id = IF(lease_expires_at < NOW(3) OR holder_id = VALUES(holder_id), VALUES(holder_id), holder_id),
         lease_expires_at = IF(lease_expires_at < NOW(3) OR holder_id = VALUES(holder_id), DATE_ADD(NOW(3), INTERVAL ? SECOND), lease_expires_at),
         updated_at = NOW(3)`,
      [this.key, this.instanceId, ttlSeconds, ttlSeconds],
    )
    const [rows] = await this.pool.query<LeadershipRow[]>(
      'SELECT holder_id FROM motor_queue_leadership WHERE leadership_key = ?', [this.key],
    )
    return rows[0]?.holder_id === this.instanceId
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const wasLeader = this.leader
    this.leader = false
    await this.pool.query(
      'UPDATE motor_queue_leadership SET lease_expires_at = NOW(3), updated_at = NOW(3) WHERE leadership_key = ? AND holder_id = ?',
      [this.key, this.instanceId],
    )
    if (wasLeader) await this.onLost?.()
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const acquired = await this.tryAcquire()
      if (acquired && !this.leader) {
        this.leader = true
        await this.onAcquired?.()
      } else if (!acquired && this.leader) {
        this.leader = false
        await this.onLost?.()
      }
    } catch (error) {
      console.error('[QueueLeadership] falha ao disputar/renovar lease:', error instanceof Error ? error.message : error)
    } finally {
      this.ticking = false
    }
  }
}
