/**
 * ResourceLeaseService - Gerenciamento de leases de recursos
 * 
 * Responsável por:
 * - Aquisição transacional de recursos
 * - Heartbeat e renovação
 * - Liberação com notificação
 * - Fencing token para evitar escritas de leases expirados
 */

import type { Db } from '@gerente-agentes/persistence'
import type {
  ResourceLease,
  AcquireResult,
  RenewResult,
  ReleaseResult,
  ResourceKey,
} from '../shared/types/resources.js'

export interface ResourceLeaseServiceConfig {
  heartbeatIntervalMs: number
  leaseExpirationMs: number
  maxWaitSeconds: number
}

const DEFAULT_CONFIG: ResourceLeaseServiceConfig = {
  heartbeatIntervalMs: 15000,
  leaseExpirationMs: 60000,
  maxWaitSeconds: 300,
}

export class ResourceLeaseService {
  private config: ResourceLeaseServiceConfig

  constructor(
    private db: Db,
    config: Partial<ResourceLeaseServiceConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Adquire um recurso ou entra na fila de espera
   */
  async acquire(
    resourceKey: ResourceKey,
    executionId: string,
    ownerId: string,
    maxWaitSeconds?: number
  ): Promise<AcquireResult> {
    const waitSeconds = maxWaitSeconds ?? this.config.maxWaitSeconds

    try {
      // Tenta adquirir diretamente
      const lease = await this.tryAcquire(resourceKey, executionId, ownerId, waitSeconds)
      if (lease) {
        return { kind: 'acquired', lease }
      }

      // Recurso ocupado, entra na fila
      const waitResult = await this.enqueueWait(resourceKey, executionId, ownerId)
      return {
        kind: 'waiting',
        waitId: waitResult.waitId,
        position: waitResult.position,
      }
    } catch (error) {
      return {
        kind: 'denied',
        reason: error instanceof Error ? error.message : 'Erro desconhecido ao adquirir recurso',
      }
    }
  }

  /**
   * Renova o heartbeat de um lease
   */
  async renew(
    resourceKey: ResourceKey,
    executionId: string,
    fencingToken: number
  ): Promise<RenewResult> {
    try {
      const result = await this.db.query(
        `UPDATE execution_resources 
         SET heartbeat_at = NOW(), 
             expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
         WHERE resource_key = ? 
           AND execution_id = ? 
           AND fencing_token = ?`,
        [this.config.leaseExpirationMs / 1000, resourceKey, executionId, fencingToken]
      )

      if (result.affectedRows === 0) {
        return { kind: 'lost', reason: 'Lease perdido ou expirado' }
      }

      const lease = await this.getLease(resourceKey)
      if (!lease) {
        return { kind: 'lost', reason: 'Lease não encontrado após renovação' }
      }

      return { kind: 'renewed', lease }
    } catch (error) {
      return {
        kind: 'lost',
        reason: error instanceof Error ? error.message : 'Erro ao renovar lease',
      }
    }
  }

  /**
   * Libera um recurso
   */
  async release(
    resourceKey: ResourceKey,
    executionId: string,
    fencingToken: number
  ): Promise<ReleaseResult> {
    try {
      const result = await this.db.query(
        `DELETE FROM execution_resources 
         WHERE resource_key = ? 
           AND execution_id = ? 
           AND fencing_token = ?`,
        [resourceKey, executionId, fencingToken]
      )

      if (result.affectedRows === 0) {
        return { kind: 'not_owner' }
      }

      // Notifica próximo da fila
      await this.notifyNextInQueue(resourceKey)

      return { kind: 'released' }
    } catch (error) {
      // Mesmo com erro, considera liberado para não bloquear outros
      console.error(`Erro ao liberar recurso ${resourceKey}:`, error)
      return { kind: 'released' }
    }
  }

  /**
   * Verifica se um recurso está disponível
   */
  async isAvailable(resourceKey: ResourceKey): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM execution_resources 
       WHERE resource_key = ? 
         AND expires_at > NOW()
       LIMIT 1`,
      [resourceKey]
    )
    return rows.length === 0
  }

  /**
   * Obtém o proprietário atual de um recurso
   */
  async getOwner(resourceKey: ResourceKey): Promise<{ executionId: string; fencingToken: number } | null> {
    const { rows } = await this.db.query(
      `SELECT execution_id, fencing_token 
       FROM execution_resources 
       WHERE resource_key = ? 
         AND expires_at > NOW()
       LIMIT 1`,
      [resourceKey]
    )
    if (rows.length === 0) return null
    const row = rows[0] as { execution_id: string; fencing_token: number }
    return { executionId: row.execution_id, fencingToken: row.fencing_token }
  }

  /**
   * Tenta adquirir um recurso diretamente
   */
  private async tryAcquire(
    resourceKey: ResourceKey,
    executionId: string,
    ownerId: string,
    maxWaitSeconds: number
  ): Promise<ResourceLease | null> {
    const { rows } = await this.db.query(
      `INSERT INTO execution_resources 
         (resource_key, execution_id, owner_id, fencing_token, heartbeat_at, acquired_at, expires_at, max_wait_seconds)
       SELECT ?, ?, ?, 1, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), ?
       WHERE NOT EXISTS (
         SELECT 1 FROM execution_resources 
         WHERE resource_key = ? 
           AND expires_at > NOW()
       )
       ON DUPLICATE KEY UPDATE
         execution_id = IF(expires_at <= NOW(), VALUES(execution_id), execution_id),
         owner_id = IF(expires_at <= NOW(), VALUES(owner_id), owner_id),
         fencing_token = IF(expires_at <= NOW(), fencing_token + 1, fencing_token),
         heartbeat_at = IF(expires_at <= NOW(), NOW(), heartbeat_at),
         acquired_at = IF(expires_at <= NOW(), NOW(), acquired_at),
         expires_at = IF(expires_at <= NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), expires_at)`,
      [
        resourceKey,
        executionId,
        ownerId,
        this.config.leaseExpirationMs / 1000,
        maxWaitSeconds,
        resourceKey,
        this.config.leaseExpirationMs / 1000,
      ]
    )

    if (rows.affectedRows === 0) {
      return null
    }

    return await this.getLease(resourceKey)
  }

  /**
   * Adiciona à fila de espera
   */
  private async enqueueWait(
    resourceKey: ResourceKey,
    executionId: string,
    ownerId: string
  ): Promise<{ waitId: number; position: number }> {
    const result = await this.db.query(
      `INSERT INTO execution_resource_queue 
         (resource_key, execution_id, owner_id, requested_at, status)
       VALUES (?, ?, ?, NOW(), 'waiting')`,
      [resourceKey, executionId, ownerId]
    )

    const waitId = result.insertId

    const { rows } = await this.db.query(
      `SELECT COUNT(*) as position 
       FROM execution_resource_queue 
       WHERE resource_key = ? 
         AND status = 'waiting' 
         AND requested_at <= (
           SELECT requested_at FROM execution_resource_queue WHERE id = ?
         )`,
      [resourceKey, waitId]
    )

    const position = (rows[0] as { position: number }).position

    return { waitId, position }
  }

  /**
   * Notifica próximo da fila
   */
  private async notifyNextInQueue(resourceKey: ResourceKey): Promise<void> {
    await this.db.query(
      `UPDATE execution_resource_queue 
       SET status = 'granted' 
       WHERE resource_key = ? 
         AND status = 'waiting'
       ORDER BY requested_at ASC
       LIMIT 1`,
      [resourceKey]
    )
  }

  /**
   * Obtém um lease ativo
   */
  private async getLease(resourceKey: ResourceKey): Promise<ResourceLease | null> {
    const { rows } = await this.db.query(
      `SELECT resource_key, execution_id, owner_id, fencing_token, 
              heartbeat_at, acquired_at, expires_at
       FROM execution_resources 
       WHERE resource_key = ? 
         AND expires_at > NOW()
       LIMIT 1`,
      [resourceKey]
    )

    if (rows.length === 0) return null

    const row = rows[0] as {
      resource_key: string
      execution_id: string
      owner_id: string
      fencing_token: number
      heartbeat_at: string
      acquired_at: string
      expires_at: string
    }

    return {
      resourceKey: row.resource_key as ResourceKey,
      executionId: row.execution_id,
      ownerId: row.owner_id,
      fencingToken: row.fencing_token,
      heartbeatAt: new Date(row.heartbeat_at),
      acquiredAt: new Date(row.acquired_at),
      expiresAt: new Date(row.expires_at),
    }
  }
}
