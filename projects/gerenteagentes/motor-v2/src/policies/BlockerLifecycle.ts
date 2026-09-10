/**
 * Ciclo de vida estruturado de bloqueios.
 *
 * Complementa o `recordBlocker` do TaskWorker (que abre bloqueios) com a
 * resolução estruturada: resolved_at, resolution, root_cause, category,
 * severity e recurrence_fingerprint.
 *
 * A medição do tempo bloqueado depende desta resolução: sem `resolved_at`,
 * o KPI "tempo bloqueado" não pode ser calculado.
 */

import type { Db } from "../shared/types/infrastructure.js"

export interface ResolveBlockerInput {
  /** ID do bloqueio na tabela `bloqueios`. */
  blockerId: number
  /** Quando o bloqueio foi resolvido. */
  resolvedAt: Date
  /** Descrição da resolução aplicada. */
  resolution: string
  /** Causa-raiz identificada (opcional). */
  rootCause?: string | null
  /** Categoria do bloqueio (ex.: "blocked_environment", "systemic_failure"). */
  category?: string | null
  /** Gravidade (ex.: "low", "medium", "high", "critical"). */
  severity?: string | null
  /** ID do responsável pela resolução (agente ou humano). */
  ownerId?: string | null
}

export interface OpenBlockerInput {
  tarefaId: number
  subtarefaId?: number | null
  blockReason: string
  blockCommand?: string | null
  blockExcerpt?: string | null
  blockedAt: Date
  category?: string | null
  severity?: string | null
  ownerId?: string | null
  recurrenceFingerprint?: string | null
}

/**
 * Repositório de ciclo de vida de bloqueios.
 * Persiste abertura e resolução com dados estruturados para KPIs.
 */
export class BlockerLifecycle {
  constructor(private readonly db: Db) {}

  /**
   * Abre um bloqueio com campos estruturados da migration 0026.
   * Retorna o ID do bloqueio criado.
   */
  async openBlocker(input: OpenBlockerInput): Promise<number> {
    const result = await this.db.query(
      `INSERT INTO bloqueios
       (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at,
        category, severity, owner_id, recurrence_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        input.tarefaId,
        input.subtarefaId ?? null,
        input.blockReason,
        input.blockCommand ?? null,
        input.blockExcerpt ?? null,
        input.blockedAt,
        input.category ?? null,
        input.severity ?? null,
        input.ownerId ?? null,
        input.recurrenceFingerprint ?? null,
      ],
    )
    return result.insertId
  }

  /**
   * Resolve um bloqueio existente, preenchendo resolved_at e dados de causa/resolução.
   * Retorna true se o bloqueio foi resolvido (affectedRows = 1), false se já estava resolvido ou não existe.
   */
  async resolveBlocker(input: ResolveBlockerInput): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE bloqueios
       SET resolved_at = ?, resolution = ?, root_cause = ?,
           category = COALESCE(?, category), severity = COALESCE(?, severity),
           owner_id = COALESCE(?, owner_id)
       WHERE id = ? AND resolved_at IS NULL`,
      [
        input.resolvedAt,
        input.resolution,
        input.rootCause ?? null,
        input.category ?? null,
        input.severity ?? null,
        input.ownerId ?? null,
        input.blockerId,
      ],
    )
    return (result.affectedRows ?? 0) === 1
  }

  /**
   * Resolve todos os bloqueios abertos de uma tarefa (ex.: quando a tarefa é retomada).
   * Retorna o número de bloqueios resolvidos.
   */
  async resolveAllForTask(tarefaId: number, resolvedAt: Date, resolution: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE bloqueios SET resolved_at = ?, resolution = ? WHERE tarefa_id = ? AND resolved_at IS NULL`,
      [resolvedAt, resolution, tarefaId],
    )
    return result.affectedRows ?? 0
  }

  /**
   * Calcula o tempo total bloqueado (em segundos) para uma tarefa,
   * somando os intervalos entre blocked_at e resolved_at de cada bloqueio.
   * Bloqueios ainda abertos usam NOW() como fim (tempo parcial).
   */
  async computeBlockedTimeSeconds(tarefaId: number): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT SUM(
         TIMESTAMPDIFF(SECOND, blocked_at, COALESCE(resolved_at, NOW()))
       ) AS total_blocked_seconds
       FROM bloqueios WHERE tarefa_id = ?`,
      [tarefaId],
    )
    return Number(rows[0]?.total_blocked_seconds ?? 0)
  }

  /**
   * Busca bloqueios recorrentes pelo fingerprint.
   * Usado para detectar padrões de falha repetida.
   */
  async findRecurrences(fingerprint: string): Promise<Array<{
    id: number
    tarefaId: number
    blockedAt: Date
    resolvedAt: Date | null
    category: string | null
  }>> {
    const { rows } = await this.db.query(
      `SELECT id, tarefa_id, blocked_at, resolved_at, category
       FROM bloqueios WHERE recurrence_fingerprint = ? ORDER BY blocked_at ASC`,
      [fingerprint],
    )
    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      tarefaId: Number(row.tarefa_id),
      blockedAt: new Date(String(row.blocked_at)),
      resolvedAt: row.resolved_at ? new Date(String(row.resolved_at)) : null,
      category: row.category ? String(row.category) : null,
    }))
  }
}
