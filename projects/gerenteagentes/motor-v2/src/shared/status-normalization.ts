/**
 * Normalização canônica de status — fonte única para leitura e escrita.
 *
 * Regras:
 * - `deployada` é legado: novas gravações DEVEM usar `deployed`.
 * - Leituras (relatórios, APIs, KPIs) interpretam `deployada` como `deployed`.
 * - Status canônicos são os definidos em task-statuses.ts e execution-event.ts.
 * - Este módulo não altera dados históricos; apenas normaliza em tempo de leitura.
 */

import { TASK_STATUSES, TASK_STATUSES_LEGACY, SUBTASK_STATUSES } from "./task-statuses.js"
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
