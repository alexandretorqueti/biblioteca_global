/**
 * AnalystReply - Contrato de resposta do analista com clarificação
 *
 * O analista responde de duas formas:
 * 1. `plano`     — JSON com `subtarefas` (formato histórico, com ou sem `kind`)
 * 2. `perguntas` — JSON com `kind: "perguntas"`, `resumo` e `perguntas[]`
 *
 * Tolerante a modelos que embrulham o JSON em cercas de código ou texto.
 */

import type { PlannedSubtask } from "./PlanPersistence.js"

export type AnalystReply =
  | { kind: "plano"; subtarefas: PlannedSubtask[] }
  | { kind: "perguntas"; resumo: string; perguntas: string[] }

/** Extrai o primeiro objeto JSON de uma resposta de modelo. */
export function extractJson(content: string): Record<string, unknown> {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error("Resposta do analista nao contem JSON")
  const parsed: unknown = JSON.parse(jsonMatch[0])
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Resposta do analista nao e um objeto JSON")
  }
  return parsed as Record<string, unknown>
}

function mapSubtarefas(value: unknown): PlannedSubtask[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Analista nao retornou subtarefas")
  }
  return value.map((item, index) => {
    const record = item as Record<string, unknown>
    return {
      seq: Number(record.seq ?? index + 1),
      titulo: String(record.titulo || "Subtarefa " + (index + 1)),
      scope: record.scope ? String(record.scope) : undefined,
      acceptanceCriteria: Array.isArray(record.acceptance_criteria)
        ? record.acceptance_criteria.map(String)
        : undefined,
    }
  })
}

function mapPerguntas(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Clarificação sem a lista 'perguntas'")
  const perguntas = value.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
  if (perguntas.length === 0) throw new Error("Clarificação sem perguntas válidas")
  return perguntas
}

/**
 * Faz o parse da resposta do analista.
 * - `perguntas`: `kind === "perguntas"` ou presença de array `perguntas`.
 * - `plano`: qualquer outro caso com `subtarefas` (compatível com o formato
 *   antigo, sem `kind`).
 */
export function parseAnalystReply(content: string): AnalystReply {
  const parsed = extractJson(content)
  const kind = typeof parsed.kind === "string" ? parsed.kind.trim().toLowerCase() : ""

  if (kind === "perguntas" || Array.isArray(parsed.perguntas)) {
    return {
      kind: "perguntas",
      resumo: typeof parsed.resumo === "string" ? parsed.resumo.trim() : "",
      perguntas: mapPerguntas(parsed.perguntas),
    }
  }

  return { kind: "plano", subtarefas: mapSubtarefas(parsed.subtarefas) }
}
