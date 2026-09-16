/**
 * ActionExecutor — executa ações (composição de primitivas) com on_partial_failure
 *
 * Uma ação é uma sequência de primitivas. Se uma primitiva falha:
 * - continue: loga erro e segue para próxima primitiva
 * - compensate: executa ação de compensação (se definida) e aborta
 * - mark_dirty: marca tarefa como dirty e aborta
 *
 * B20: semântica de falha parcial por ação composta.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { CatalogLoader, CatalogAction } from '../catalog/CatalogLoader.js'
import type { MotorContext } from '../shared/context.js'
import * as schema from '../db/schema.js'
import { eq } from 'drizzle-orm'

export type PrimitiveHandler = (context: MotorContext, params?: Record<string, any>) => Promise<PrimitiveResult>

export interface PrimitiveResult {
  success: boolean
  message?: string
  data?: any
}

export interface ActionResult {
  actionCode: string
  success: boolean
  primitivesExecuted: string[]
  error?: string
  compensated: boolean
}

export class ActionExecutor {
  private db: NodePgDatabase<typeof schema>
  private loader: CatalogLoader
  private primitives = new Map<string, PrimitiveHandler>()

  constructor(db: NodePgDatabase<typeof schema>, loader: CatalogLoader) {
    this.db = db
    this.loader = loader
  }

  /**
   * Registra handler para uma primitiva.
   */
  registerPrimitive(code: string, handler: PrimitiveHandler): void {
    this.primitives.set(code, handler)
  }

  /**
   * Executa ação por ID.
   */
  async execute(actionId: number, context: MotorContext): Promise<ActionResult> {
    const action = await this.loader.getActionById(actionId)
    if (!action) {
      return {
        actionCode: `unknown_${actionId}`,
        success: false,
        primitivesExecuted: [],
        error: `Action ${actionId} not found`,
        compensated: false,
      }
    }

    return this.executeAction(action, context)
  }

  /**
   * Executa ação por código.
   */
  async executeByCode(actionCode: string, context: MotorContext): Promise<ActionResult> {
    const catalog = await this.loader.load()
    const action = catalog.actions.find(a => a.code === actionCode)
    if (!action) {
      return {
        actionCode,
        success: false,
        primitivesExecuted: [],
        error: `Action ${actionCode} not found`,
        compensated: false,
      }
    }

    return this.executeAction(action, context)
  }

  /**
   * Executa ação (sequência de primitivas).
   */
  private async executeAction(action: CatalogAction, context: MotorContext): Promise<ActionResult> {
    const primitivesExecuted: string[] = []
    let compensated = false

    for (const primitiveCall of action.primitives) {
      const handler = this.primitives.get(primitiveCall.primitive)

      if (!handler) {
        // Primitiva não registrada
        const error = `Primitive ${primitiveCall.primitive} not registered`
        console.error(`[ActionExecutor] ${error}`)

        // Aplica on_partial_failure
        const shouldAbort = await this.handlePartialFailure(action, context, error)
        if (shouldAbort) {
          return {
            actionCode: action.code,
            success: false,
            primitivesExecuted,
            error,
            compensated: action.onPartialFailure === 'compensate',
          }
        }
        continue
      }

      try {
        const result = await handler(context, primitiveCall.params)
        primitivesExecuted.push(primitiveCall.primitive)

        if (!result.success) {
          // Primitiva falhou
          const error = result.message ?? `Primitive ${primitiveCall.primitive} failed`
          console.error(`[ActionExecutor] ${error}`)

          // Aplica on_partial_failure
          const shouldAbort = await this.handlePartialFailure(action, context, error)
          if (shouldAbort) {
            return {
              actionCode: action.code,
              success: false,
              primitivesExecuted,
              error,
              compensated: action.onPartialFailure === 'compensate',
            }
          }
        }
      } catch (err) {
        // Primitiva lançou exceção
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[ActionExecutor] Primitive ${primitiveCall.primitive} threw: ${error}`)

        // Aplica on_partial_failure
        const shouldAbort = await this.handlePartialFailure(action, context, error)
        if (shouldAbort) {
          return {
            actionCode: action.code,
            success: false,
            primitivesExecuted,
            error,
            compensated: action.onPartialFailure === 'compensate',
          }
        }
      }
    }

    return {
      actionCode: action.code,
      success: true,
      primitivesExecuted,
      compensated: false,
    }
  }

  /**
   * Trata falha parcial conforme on_partial_failure da ação.
   * Retorna true se deve abortar, false se deve continuar.
   */
  private async handlePartialFailure(
    action: CatalogAction,
    context: MotorContext,
    error: string
  ): Promise<boolean> {
    switch (action.onPartialFailure) {
      case 'continue':
        // Loga e segue
        console.warn(`[ActionExecutor] ${action.code}: partial failure, continuing — ${error}`)
        return false

      case 'compensate':
        // Executa ação de compensação (se definida)
        if (action.compensationActionId) {
          console.warn(`[ActionExecutor] ${action.code}: partial failure, compensating with action ${action.compensationActionId}`)
          const compensationAction = await this.loader.getActionById(action.compensationActionId)
          if (compensationAction) {
            await this.executeAction(compensationAction, context)
          }
        } else {
          console.warn(`[ActionExecutor] ${action.code}: partial failure, no compensation action defined`)
        }
        return true

      case 'mark_dirty':
        // Marca tarefa como dirty
        console.warn(`[ActionExecutor] ${action.code}: partial failure, marking task dirty`)
        await this.markTaskDirty(context.taskId, error)
        return true

      default:
        // Fallback: aborta
        console.error(`[ActionExecutor] ${action.code}: unknown on_partial_failure value`)
        return true
    }
  }

  /**
   * Marca tarefa como dirty (B20).
   */
  private async markTaskDirty(taskId: string, error: string): Promise<void> {
    await this.db.insert(schema.motorPromotionState).values({
      tarefaId: taskId,
      dirty: 1,
      errorMessage: error,
      attempts: 1,
      lastAttemptAt: new Date(),
    }).onDuplicateKeyUpdate({
      set: {
        dirty: 1,
        errorMessage: error,
        attempts: sql`attempts + 1`,
        lastAttemptAt: new Date(),
      },
    })
  }

  /**
   * Lista primitivas registradas (para debug).
   */
  getRegisteredPrimitives(): string[] {
    return Array.from(this.primitives.keys())
  }
}
