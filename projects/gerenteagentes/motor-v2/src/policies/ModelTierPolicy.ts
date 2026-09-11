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
  // O Console pode devolver a falha diretamente como RemoteSessionFailure,
  // e não como Error. A indisponibilidade precisa continuar escalando a
  // cadeia nesses dois formatos (createSession usa Error; waitForRun usa o
  // objeto estruturado retornado no resultado).
  const candidate = error as (Error & { status?: number; code?: string }) | {
    status?: unknown
    code?: unknown
    message?: unknown
  } | null | undefined
  if (!candidate || typeof candidate !== "object") return false
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : ""
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : ""
  return candidate.status === 404 || candidate.status === 422 ||
    code.includes("model_not_found") || code.includes("model_unavailable") ||
    code.includes("model_not_allowed") ||
    // O Console pode reportar uma sessão recusada pelo modelo como
    // SESSION_FAILED, sem expor status HTTP ou código específico do modelo.
    code.includes("session_failed") || message.includes("[session_failed]") ||
    message.includes("session failed") ||
    message.includes("model not found") || message.includes("modelo indisponível") ||
    message.includes("model unavailable") || message.includes("model not allowed")
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
