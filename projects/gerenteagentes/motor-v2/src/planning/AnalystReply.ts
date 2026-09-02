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

/**
 * Classificação de falha de parse da resposta do analista.
 *
 * - `truncated`: a geração foi cortada no meio (teto de saída do modelo).
 *   Sintomas: erro de sintaxe "string não terminada"/"fim inesperado do JSON",
 *   ou conteúdo sem nenhuma chave de fechamento.
 * - `invalid`: qualquer outra resposta fora do contrato (sem JSON, sem
 *   subtarefas, clarificação sem perguntas etc.).
 *
 * Ambas são falhas RETRYÁVEIS: o motor tenta 1 retry corretivo no mesmo
 * modelo e depois escala para o próximo da escada — nunca bloqueia a tarefa.
 */
export type AnalystParseFailure =
  | { kind: "truncated"; message: string }
  | { kind: "invalid"; message: string }

const TRUNCATED_JSON_ERROR_PATTERN = /unterminated string|unexpected end of json|end of json input/i

export function classifyAnalystParseFailure(content: string, error: unknown): AnalystParseFailure {
  const message = error instanceof Error ? error.message : String(error)
  const truncatedByError = TRUNCATED_JSON_ERROR_PATTERN.test(message)
  const trimmed = content.trim()
  // Abriu um objeto JSON mas nao ha nenhuma chave de fechamento: a geração
  // parou antes de fechar. Texto sem "{" sequer nao e truncamento — e
  // resposta fora do contrato (invalid).
  const truncatedByShape = trimmed.includes("{") && !trimmed.includes("}")
  if (truncatedByError || truncatedByShape) {
    return { kind: "truncated", message }
  }
  return { kind: "invalid", message }
}

export type SafeAnalystParse =
  | { ok: true; reply: AnalystReply }
  | { ok: false; failure: AnalystParseFailure }

/** Versão que nunca lança: classifica a falha para o motor decidir retry/escala. */
export function safeParseAnalystReply(content: string): SafeAnalystParse {
  try {
    return { ok: true, reply: parseAnalystReply(content) }
  } catch (error) {
    return { ok: false, failure: classifyAnalystParseFailure(content, error) }
  }
}
