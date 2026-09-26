/**
 * Persistência do cooldown de modelos (tabela `modelo_cooldown`).
 *
 * Global por (provider, model). Uma linha por modelo; reincidência incrementa
 * `strikes` (e o tempo cresce conforme `ModelCooldownPolicy`). Um modelo que
 * ficou fora do cooldown por mais tempo que sua janela-base é considerado
 * recuperado e volta a contar do zero.
 */

import type { Db } from "../shared/types/infrastructure.js"
import {
  classifyCooldown,
  cooldownBaseMs,
  cooldownDurationMs,
  modelKey,
  splitModelKey,
  type ActiveCooldown,
  type ModelCooldownClass,
} from "../policies/ModelCooldownPolicy.js"

export class ModelCooldownStore {
  constructor(private readonly db: Db) {}

  /** Cooldowns vigentes, indexados por `provider/model`. */
  async listActive(now: Date = new Date()): Promise<Map<string, ActiveCooldown>> {
    const { rows } = await this.db.query(
      "SELECT provider, model, motivo_classe, strikes, bloqueado_ate FROM modelo_cooldown WHERE bloqueado_ate > ?",
      [now],
    )
    const map = new Map<string, ActiveCooldown>()
    for (const row of rows) {
      const key = modelKey(String(row.provider), String(row.model))
      map.set(key, {
        model: key,
        classe: String(row.motivo_classe) as ModelCooldownClass,
        until: new Date(row.bloqueado_ate as string | number | Date),
        strikes: Number(row.strikes ?? 1),
      })
    }
    return map
  }

  /** Modelos em cooldown como lista, ordenada pelo fim mais próximo. */
  async listActiveOrdered(now: Date = new Date()): Promise<ActiveCooldown[]> {
    const map = await this.listActive(now)
    return [...map.values()].sort((a, b) => a.until.getTime() - b.until.getTime())
  }

  /** Registra indisponibilidade e devolve o cooldown aplicado. */
  async register(input: { model: string; reason: string; now?: Date }): Promise<ActiveCooldown> {
    const now = input.now ?? new Date()
    const { provider, model } = splitModelKey(input.model)
    const classe = classifyCooldown(input.reason)

    const { rows } = await this.db.query(
      "SELECT strikes, bloqueado_ate FROM modelo_cooldown WHERE provider = ? AND model = ? LIMIT 1",
      [provider, model],
    )
    const previous = rows[0] as Record<string, unknown> | undefined
    let strikes = 1
    if (previous) {
      const previousUntil = new Date(previous.bloqueado_ate as string | number | Date)
      const previousStrikes = Number(previous.strikes ?? 0)
      // Recuperado = passou do cooldown por mais tempo que a janela-base atual.
      const recovered = Number.isFinite(previousUntil.getTime()) &&
        now.getTime() - previousUntil.getTime() > cooldownBaseMs(classe)
      strikes = (recovered ? 0 : previousStrikes) + 1
    }

    const until = new Date(now.getTime() + cooldownDurationMs(classe, strikes))
    const motivo = input.reason.slice(0, 500)
    await this.db.query(
      "INSERT INTO modelo_cooldown (provider, model, motivo, motivo_classe, strikes, bloqueado_ate, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE motivo = VALUES(motivo), motivo_classe = VALUES(motivo_classe), " +
      "strikes = VALUES(strikes), bloqueado_ate = VALUES(bloqueado_ate), updated_at = VALUES(updated_at)",
      [provider, model, motivo, classe, strikes, until, now, now],
    )
    return { model: modelKey(provider, model), classe, until, strikes }
  }

  /** Libera um modelo manualmente (ou zera contrato de reincidência). */
  async clear(model: string): Promise<void> {
    const { provider, model: name } = splitModelKey(model)
    await this.db.query("DELETE FROM modelo_cooldown WHERE provider = ? AND model = ?", [provider, name])
  }
}
