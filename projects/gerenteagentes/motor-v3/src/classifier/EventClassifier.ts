/**
 * EventClassifier — classifica erro contra catálogo, incrementa ocorrência atomicamente
 *
 * Dado um erro (code + message + stack + action_result), percorre eventos ativos
 * ordenados por prioridade (menor = mais prioritário) e testa patterns.
 * Se match encontrado, incrementa occurrence atomicamente e retorna reação correspondente.
 *
 * Escopo de contagem: (event_id, task_id, subtask_id, generation) — B13.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, and, eq } from 'drizzle-orm'
import type { CatalogLoader, CatalogEvent, CatalogReaction, CatalogAction } from '../catalog/CatalogLoader.js'
import * as schema from '../db/schema.js'

export interface ErrorInput {
  code?: string
  message?: string
  stack?: string
  actionResult?: string
}

export interface ClassificationResult {
  event: CatalogEvent
  occurrence: number
  reaction: CatalogReaction
  action: CatalogAction
}

export class EventClassifier {
  private db: NodePgDatabase<typeof schema>
  private loader: CatalogLoader

  constructor(db: NodePgDatabase<typeof schema>, loader: CatalogLoader) {
    this.db = db
    this.loader = loader
  }

  /**
   * Classifica erro contra catálogo.
   * Retorna null se nenhum pattern casar (erro não catalogado → B01).
   */
  async classify(
    taskId: string,
    subtaskId: number | null,
    generation: number,
    error: ErrorInput
  ): Promise<ClassificationResult | null> {
    const catalog = await this.loader.load()

    // Eventos ordenados por prioridade (menor = mais prioritário)
    const events = catalog.events.sort((a, b) => a.priority - b.priority)

    for (const event of events) {
      const patterns = await this.loader.getPatternsForEvent(event.id)

      // Testa cada pattern contra cada target
      for (const pattern of patterns) {
        const target = this.getTargetValue(error, pattern.matchTarget)
        if (!target) continue

        if (this.matchPattern(target, pattern.pattern, pattern.matchType)) {
          // Match encontrado — incrementa ocorrência atomicamente
          const occurrence = await this.incrementOccurrence(event.id, taskId, subtaskId, generation)

          // Busca reação correspondente
          const reactions = await this.loader.getReactionsForEvent(event.id)
          const reaction = reactions.find(r => r.occurrence === occurrence)

          if (!reaction) {
            // Nenhuma reação definida para essa ocorrência — fallback para última
            const lastReaction = reactions[reactions.length - 1]
            if (!lastReaction) {
              // Evento sem reações — logar warning
              console.warn(`[EventClassifier] Event ${event.code} has no reactions defined`)
              continue
            }
            const action = await this.loader.getActionById(lastReaction.actionId)
            if (!action) continue

            return {
              event,
              occurrence,
              reaction: lastReaction,
              action,
            }
          }

          const action = await this.loader.getActionById(reaction.actionId)
          if (!action) {
            console.warn(`[EventClassifier] Action ${reaction.actionId} not found for event ${event.code}`)
            continue
          }

          return {
            event,
            occurrence,
            reaction,
            action,
          }
        }
      }
    }

    // Nenhum pattern casou — erro não catalogado
    return null
  }

  /**
   * Incrementa ocorrência atomicamente (INSERT ON DUPLICATE KEY UPDATE).
   * B13: escopo = (event_id, task_id, subtask_id, generation).
   */
  private async incrementOccurrence(
    eventId: number,
    taskId: string,
    subtaskId: number | null,
    generation: number
  ): Promise<number> {
    const result = await this.db.execute(sql`
      INSERT INTO motor_occurrences (event_id, tarefa_id, subtarefa_id, generation, count, last_occurred_at)
      VALUES (${eventId}, ${taskId}, ${subtaskId}, ${generation}, 1, NOW())
      ON DUPLICATE KEY UPDATE
        count = count + 1,
        last_occurred_at = NOW()
    `)

    // Busca contagem atualizada
    const rows = await this.db.select({ count: schema.motorOccurrences.count })
      .from(schema.motorOccurrences)
      .where(
        and(
          eq(schema.motorOccurrences.eventId, eventId),
          eq(schema.motorOccurrences.tarefaId, taskId),
          subtaskId !== null ? eq(schema.motorOccurrences.subtarefaId, subtaskId) : sql`${schema.motorOccurrences.subtarefaId} IS NULL`,
          eq(schema.motorOccurrences.generation, generation)
        )
      )

    return rows[0]?.count ?? 1
  }

  /**
   * Extrai valor do target do erro.
   */
  private getTargetValue(error: ErrorInput, target: string): string | null {
    switch (target) {
      case 'code':
        return error.code ?? null
      case 'message':
        return error.message ?? null
      case 'stack':
        return error.stack ?? null
      case 'action_result':
        return error.actionResult ?? null
      default:
        return null
    }
  }

  /**
   * Testa se pattern casa com target.
   */
  private matchPattern(target: string, pattern: string, matchType: string): boolean {
    switch (matchType) {
      case 'contains':
        return target.toLowerCase().includes(pattern.toLowerCase())
      case 'exact':
        return target === pattern
      case 'regex':
        try {
          const regex = new RegExp(pattern, 'i')
          return regex.test(target)
        } catch (err) {
          console.warn(`[EventClassifier] Invalid regex pattern: ${pattern}`)
          return false
        }
      default:
        return false
    }
  }
}
