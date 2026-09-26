import type { PromotionConflictAnalysisResult, PromotionConflictEvidence } from "./promotion-conflict.types.js"

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  if (!candidate) return null
  try { return JSON.parse(candidate) as Record<string, unknown> } catch { return null }
}

/**
 * A primeira versão automatiza o diagnóstico, não a escrita do merge.
 * Mesmo uma recomendação de alta confiança permanece sujeita ao gate humano.
 */
export function evaluatePromotionConflictAnalysis(rawReport: string, evidence: PromotionConflictEvidence): PromotionConflictAnalysisResult {
  const parsed = extractJson(rawReport)
  const requestedConfidence = parsed?.confidence
  const confidence = requestedConfidence === "high" || requestedConfidence === "medium" || requestedConfidence === "low"
    ? requestedConfidence : "low"
  const hasUnknown = evidence.conflictFiles.some((file) => file.kind === "unknown")
  const recommendation = !hasUnknown && confidence === "high"
    ? "create_resolution_subtask" as const
    : "human_review" as const
  return { recommendation, confidence, report: rawReport }
}

