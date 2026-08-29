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
  if (!(error instanceof Error)) return false
  const candidate = error as Error & { status?: number; code?: string }
  const code = candidate.code?.toLowerCase() ?? ""
  const message = candidate.message.toLowerCase()
  return candidate.status === 404 || candidate.status === 422 ||
    code.includes("model_not_found") || code.includes("model_unavailable") ||
    message.includes("model not found") || message.includes("modelo indisponível") ||
    message.includes("model unavailable")
}

export function formatSessionKey(input: {
  agentId: string
  taskId: string
  phase: ModelPhase
  model: string
  modelIndex: number
  generation: number
}): string {
  const slug = input.model.split("/").at(-1)?.replace(/[^a-zA-Z0-9.-]/g, "_") || "unknown"
  const phase = input.phase === "analysis" ? "analysis" : input.phase === "development" ? "dev" : "monitor"
  return `${phase}-${slug}-${input.taskId}`
}
