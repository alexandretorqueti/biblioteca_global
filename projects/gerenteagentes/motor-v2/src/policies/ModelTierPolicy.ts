export type ModelPhase = "analysis" | "development" | "monitor"

export interface ModelSelection {
  model: string
  position: number
  isLocal: boolean
}

export const DEFAULT_ANALYSIS_CHAIN: readonly ModelSelection[] = [
  { model: "alibaba/qwen3.8-max", position: 0, isLocal: false },
  { model: "openai/gpt-5.6-terra", position: 1, isLocal: false },
]

export const DEFAULT_DEVELOPMENT_CHAIN: readonly ModelSelection[] = [
  { model: "alibaba/qwen3.7-max", position: 0, isLocal: false },
  { model: "alibaba/qwen3.8-max", position: 1, isLocal: false },
  { model: "openai/gpt-5.6-terra", position: 2, isLocal: false },
]

export function defaultChain(phase: ModelPhase): readonly ModelSelection[] {
  return phase === "analysis" ? DEFAULT_ANALYSIS_CHAIN : DEFAULT_DEVELOPMENT_CHAIN
}

export function isModelUnavailableError(error: unknown): boolean {
  // O Console pode devolver a falha como Error ou como payload estruturado.
  // Normalizar ambos evita perder o fallback quando SESSION_FAILED chega sem
  // ser encapsulado por Error.
  if (error === null || (typeof error !== "object" && typeof error !== "string")) return false
  const candidate = typeof error === "string" ? { message: error } : error as { message?: unknown; status?: unknown; code?: unknown }
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : ""
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : ""
  return candidate.status === 404 || candidate.status === 422 ||
    code.includes("model_not_found") || code.includes("model_unavailable") ||
    code.includes("session_failed") ||
    message.includes("model not found") || message.includes("modelo indisponível") ||
    message.includes("model unavailable") || message.includes("model not allowed") ||
    message.includes("[session_failed]")
}

export function formatSessionKey(input: {
  agentId: string
  taskId: string
  phase: ModelPhase
  model: string
  modelIndex: number
  generation: number
  /** Sessões de desenvolvimento não podem vazar contexto entre subtarefas. */
  subtaskId?: string
}): string {
  const slug = input.model.split("/").at(-1)?.replace(/[^a-zA-Z0-9.-]/g, "_") || "unknown"
  const phase = input.phase === "analysis" ? "analysis" : input.phase === "development" ? "dev" : "monitor"
  return `${phase}-${slug}-${input.taskId}${input.subtaskId ? `-s${input.subtaskId}` : ""}`
}
