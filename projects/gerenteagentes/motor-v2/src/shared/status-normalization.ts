/**
 * Normalização canônica de status — fonte única para leitura e escrita.
 *
 * ## Regras
 *
 * 1. `deployada` é legado: novas gravações DEVEM usar `deployed`.
 * 2. Leituras (relatórios, APIs, KPIs) interpretam `deployada` como `deployed`.
 * 3. Status canônicos são os definidos em task-statuses.ts e execution-event.ts.
 * 4. Este módulo não altera dados históricos; apenas normaliza em tempo de leitura.
 * 5. `superseded` é excluído do denominador de KPIs SOMENTE quando a sucessora existe.
 *
 * ## Fluxo de uso
 *
 * - **Escrita:** usar `assertWritableTaskStatus()` antes de gravar.
 * - **Leitura:** usar `normalizeTaskStatus()` ou `normalizeTaskRow()` ao expor via API/relatório.
 * - **KPIs:** usar `computeSubtaskDenominator()` para calcular denominadores elegíveis.
 */

import {
  TASK_STATUSES,
  TASK_STATUSES_LEGACY,
  SUBTASK_STATUSES,
  SUBTASK_STATUS_CATEGORIES,
} from "./task-statuses.js"
import type { TaskStatusValue, SubTaskStatusValue, AnyTaskStatus } from "./task-statuses.js"

/** Status legados que não devem ser gravados em novas operações. */
export const LEGACY_TASK_STATUSES: ReadonlySet<string> = new Set<string>(TASK_STATUSES_LEGACY)

/** Mapa de normalização: status legado → canônico. */
const TASK_STATUS_NORMALIZATION: Readonly<Record<string, TaskStatusValue>> = {
  deployada: "deployed",
  finalizada: "completed",
  aborted: "cancelled",
}

/**
 * Normaliza um status de tarefa para o canônico.
 * - `deployada` → `deployed`
 * - `finalizada` → `completed`
 * - `aborted` → `cancelled`
 * - Status já canônicos retornam inalterados.
 */
export function normalizeTaskStatus(status: string): TaskStatusValue {
  const normalized = TASK_STATUS_NORMALIZATION[status]
  if (normalized) return normalized
  if (TASK_STATUSES.includes(status as TaskStatusValue)) return status as TaskStatusValue
  // Status desconhecido: retorna como está (compatibilidade defensiva).
  return status as TaskStatusValue
}

/**
 * Verifica se um status de tarefa é canônico (pode ser gravado).
 * Status legados NÃO devem ser usados em novas gravações.
 */
export function isCanonicalTaskStatus(status: string): status is TaskStatusValue {
  return TASK_STATUSES.includes(status as TaskStatusValue)
}

/**
 * Verifica se um status é legado (existe apenas para compatibilidade).
 */
export function isLegacyTaskStatus(status: string): boolean {
  return LEGACY_TASK_STATUSES.has(status)
}

/**
 * Valida se um status pode ser gravado em nova operação.
 * Retorna o status canônico ou lança erro se for legado.
 */
export function assertWritableTaskStatus(status: string): TaskStatusValue {
  if (isLegacyTaskStatus(status)) {
    throw new Error(
      `Status legado "${status}" não pode ser gravado. Use "${normalizeTaskStatus(status)}" em vez disso.`
    )
  }
  if (!isCanonicalTaskStatus(status)) {
    throw new Error(`Status desconhecido "${status}" não é gravável.`)
  }
  return status
}

/**
 * Normaliza uma lista de status de subtarefa.
 * Subtarefas não possuem status legados conhecidos; apenas valida canonicidade.
 */
export function normalizeSubtaskStatus(status: string): SubTaskStatusValue {
  if (SUBTASK_STATUSES.includes(status as SubTaskStatusValue)) return status as SubTaskStatusValue
  return status as SubTaskStatusValue
}

/**
 * Normaliza um registro de tarefa lido do banco para exposição em APIs/relatórios.
 * Converte `deployada` → `deployed` e demais legados.
 */
export function normalizeTaskRow<T extends { status: string }>(row: T): T & { status: TaskStatusValue } {
  return { ...row, status: normalizeTaskStatus(row.status) }
}

/**
 * Normaliza um array de registros de tarefas.
 */
export function normalizeTaskRows<T extends { status: string }>(rows: T[]): Array<T & { status: TaskStatusValue }> {
  return rows.map(normalizeTaskRow)
}

// ============================================================================
// SUBTASK DENOMINATOR & SUPERSEDED LOGIC
// ============================================================================

/**
 * Registro mínimo de subtarefa para cálculo de denominador.
 * O campo `supersededBySubtaskId` indica se existe uma sucessora.
 */
export interface SubtaskDenominatorRow {
  id: number
  status: string
  supersededBySubtaskId?: number | null
}

/**
 * Determina se uma subtarefa `superseded` deve ser excluída do denominador.
 *
 * Regra: `superseded` é excluído SOMENTE quando a sucessora existe
 * (superseded_by_subtask_id IS NOT NULL). Se a sucessora não foi criada
 * (ex.: falha durante refutação de premissa), a subtarefa original conta
 * no denominador para não subestimar o escopo.
 */
export function isSupersededWithSuccessor(row: SubtaskDenominatorRow): boolean {
  if (normalizeSubtaskStatus(row.status) !== "superseded") return false
  return row.supersededBySubtaskId != null && row.supersededBySubtaskId > 0
}

/**
 * Calcula o denominador elegível de um conjunto de subtarefas para KPIs.
 *
 * Exclui:
 * - `skipped` (sempre excluído)
 * - `superseded` COM sucessora (excluído condicional)
 *
 * Retorna os IDs elegíveis e o total para uso em cálculos de avanço.
 */
export function computeSubtaskDenominator(
  subtasks: SubtaskDenominatorRow[],
): { eligibleIds: number[]; excludedIds: number[]; total: number } {
  const eligibleIds: number[] = []
  const excludedIds: number[] = []

  for (const st of subtasks) {
    const normalizedStatus = normalizeSubtaskStatus(st.status)
    const category = SUBTASK_STATUS_CATEGORIES[normalizedStatus]

    if (category === "excluded") {
      excludedIds.push(st.id)
    } else if (category === "excluded_conditional") {
      if (isSupersededWithSuccessor(st)) {
        excludedIds.push(st.id)
      } else {
        eligibleIds.push(st.id)
      }
    } else {
      eligibleIds.push(st.id)
    }
  }

  return { eligibleIds, excludedIds, total: eligibleIds.length }
}

/**
 * Normaliza o status de um registro de subtarefa para exposição em APIs.
 */
export function normalizeSubtaskRow<T extends { status: string }>(row: T): T & { status: SubTaskStatusValue } {
  return { ...row, status: normalizeSubtaskStatus(row.status) }
}

/**
 * Normaliza um array de registros de subtarefas.
 */
export function normalizeSubtaskRows<T extends { status: string }>(rows: T[]): Array<T & { status: SubTaskStatusValue }> {
  return rows.map(normalizeSubtaskRow)
}
