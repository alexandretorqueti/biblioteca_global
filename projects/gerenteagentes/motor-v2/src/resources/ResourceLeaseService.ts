/**
 * ResourceLeaseService - Gerenciamento de leases de recursos
 * 
 * Responsável por:
 * - Adquirir locks exclusivos no banco
 * - Gerenciar heartbeat e renovação
 * - Fila de espera quando recurso está ocupado
 * - Fencing token para evitar condições de corrida
 */

import type { Db } from '../shared/types/infrastructure.js'
import type { ResourceKey, ResourceLease, AcquireResult } from '../shared/types/resources.js'
import { resourceEventBus } from './ResourceEventBus.js'

export interface ResourceLeaseServiceConfig {
  db: Db
  defaultLeaseMs?: number
  heartbeatIntervalMs?: number
}

export class ResourceLeaseService {
  private db: Db
  private defaultLeaseMs: number
  private heartbeatIntervalMs: number

  constructor(config: ResourceLeaseServiceConfig) {
    this.db = config.db
    this.defaultLeaseMs = config.defaultLeaseMs ?? 60000 // 60s
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 10000 // 10s
  }

  /**
   * Adquire um recurso (lock)
   * 
   * @param resourceKey - Identificador do recurso
   * @param executionId - ID da execução que está adquirindo
   * @param ownerId - ID do owner (task/subtask)
   * @param maxWaitSeconds - Timeout para esperar na fila
   */
  async acquire(
    resourceKey: ResourceKey,
    executionId: string,
    ownerId: string,
    maxWaitSeconds: number = 60
  ): Promise<AcquireResult> {
    const now = new Date()
    void maxWaitSeconds // reservado para o reconciliador da fila
    const expiresAt = new Date(now.getTime() + this.defaultLeaseMs)

    try {
      // Tenta adquirir diretamente via transação
      const result = await this.db.transaction(async (tx) => {
        // Verifica se recurso está livre
        const { rows } = await tx.query(
          `SELECT resource_key, execution_id, fencing_token, expires_at
           FROM execution_resources
           WHERE resource_key = ?`,
          [resourceKey]
        )

        if (rows.length === 0) {
          // Recurso livre, adquire
          await tx.query(
            `INSERT INTO execution_resources
             (resource_key, execution_id, owner_id, fencing_token, heartbeat_at, acquired_at, expires_at)
             VALUES (?, ?, ?, 1, NOW(), NOW(), ?)`,
            [resourceKey, executionId, ownerId, expiresAt]
          )

          const lease: ResourceLease = {
            resourceKey,
            executionId,
            ownerId,
            fencingToken: 1,
            heartbeatAt: now,
            acquiredAt: now,
            expiresAt,
          }

          return { kind: 'acquired' as const, lease }
        }

        // Recurso ocupado, verifica se expirou
        const existing = rows[0]!
        const existingExpires = new Date(String(existing.expires_at))

        if (existingExpires < now) {
          // Lock expirado, adquire com fencing token incrementado
          const newToken = Number(existing.fencing_token) + 1

          await tx.query(
            `UPDATE execution_resources
             SET execution_id = ?, owner_id = ?, fencing_token = ?,
                 heartbeat_at = NOW(), acquired_at = NOW(), expires_at = ?
             WHERE resource_key = ?`,
            [executionId, ownerId, newToken, expiresAt, resourceKey]
          )

          const lease: ResourceLease = {
            resourceKey,
            executionId,
            ownerId,
            fencingToken: newToken,
            heartbeatAt: now,
            acquiredAt: now,
            expiresAt,
          }

          return { kind: 'acquired' as const, lease }
        }

        // Recurso ocupado e válido, adiciona à fila
        const queueResult = await tx.query(
          `INSERT INTO execution_resource_queue
           (resource_key, execution_id, task_id, priority, requested_at)
           VALUES (?, ?, ?, 0, NOW())`,
          [resourceKey, executionId, ownerId]
        )

        const waitId = queueResult.insertId
        const { rows: queueRows } = await tx.query(
          `SELECT COUNT(*) as position
           FROM execution_resource_queue
           WHERE resource_key = ? AND requested_at <= NOW()`,
          [resourceKey]
        )

        const position = Number(queueRows[0]?.position ?? 1)

        return { kind: 'waiting' as const, waitId, position }
      })

      return result
    } catch (error) {
      return {
        kind: 'denied',
        reason: error instanceof Error ? error.message : String(error),
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
  ): Promise<{ kind: 'renewed'; lease: ResourceLease } | { kind: 'lost'; reason: string }> {
    const expiresAt = new Date(Date.now() + this.defaultLeaseMs)

    try {
      const { affectedRows } = await this.db.query(
        `UPDATE execution_resources
         SET heartbeat_at = NOW(), expires_at = ?
         WHERE resource_key = ? AND execution_id = ? AND fencing_token = ?`,
        [expiresAt, resourceKey, executionId, fencingToken]
      )

      if (affectedRows === 0) {
        return { kind: 'lost', reason: 'Lease não encontrado ou fencing token inválido' }
      }

      const { rows } = await this.db.query(
        `SELECT * FROM execution_resources
         WHERE resource_key = ? AND execution_id = ?`,
        [resourceKey, executionId]
      )

      if (rows.length === 0) {
        return { kind: 'lost', reason: 'Lease desapareceu após renovação' }
      }

      const row = rows[0]!
      const lease: ResourceLease = {
        resourceKey: String(row.resource_key) as ResourceKey,
        executionId: String(row.execution_id),
        ownerId: String(row.owner_id),
        fencingToken: Number(row.fencing_token),
        heartbeatAt: new Date(String(row.heartbeat_at)),
        acquiredAt: new Date(String(row.acquired_at)),
        expiresAt: new Date(String(row.expires_at)),
      }

      return { kind: 'renewed', lease }
    } catch (error) {
      return {
        kind: 'lost',
        reason: error instanceof Error ? error.message : String(error),
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
  ): Promise<{ kind: 'released' } | { kind: 'not_found' }> {
    const { affectedRows } = await this.db.query(
      `DELETE FROM execution_resources
       WHERE resource_key = ? AND execution_id = ? AND fencing_token = ?`,
      [resourceKey, executionId, fencingToken]
    )

    if (affectedRows === 0) {
      return { kind: 'not_found' }
    }

    resourceEventBus.publish({
      type: 'released',
      resourceKey,
      executionId,
      timestamp: new Date(),
    })

    return { kind: 'released' }
  }

  /**
   * Verifica se um recurso está disponível
   */
  async isAvailable(resourceKey: ResourceKey): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT expires_at FROM execution_resources
       WHERE resource_key = ? AND expires_at > NOW()`,
      [resourceKey]
    )

    return rows.length === 0
  }

  /**
   * Obtém o owner atual de um recurso
   */
  async getOwner(resourceKey: ResourceKey): Promise<{ executionId: string; ownerId: string } | null> {
    const { rows } = await this.db.query(
      `SELECT execution_id, owner_id FROM execution_resources
       WHERE resource_key = ? AND expires_at > NOW()`,
      [resourceKey]
    )

    if (rows.length === 0) {
      return null
    }

    const row = rows[0]!
    return {
      executionId: String(row.execution_id),
      ownerId: String(row.owner_id),
    }
  }
}
