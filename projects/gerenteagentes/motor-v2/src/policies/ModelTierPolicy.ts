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
    code.includes("provider_auth_error") || code.includes("missing_provider_auth") ||
    code.includes("authentication_error") || code.includes("invalid_api_key") ||
    message.includes("model not found") || message.includes("modelo indisponível") ||
    message.includes("model unavailable") || message.includes("model not allowed") ||
    message.includes("no api key found") || message.includes("missing api key") ||
    message.includes("provider auth error") || message.includes("invalid api key") ||
    message.includes("authentication error") || message.includes("unauthorized")
}

/**
 * Indisponibilidade do provedor do MODELO (não do Console/Gateway).
 *
 * Cota esgotada, rate limit, chave inválida ou modelo removido chegam pela
 * sessão remota como texto (`[SESSION_FAILED] ... 429 Your token-plan 1-week
 * quota has been exhausted`). Sem esta leitura o Motor classificava como falha
 * transitória do Console e repetia o MESMO modelo indefinidamente (loop
 * observado em 2026-09-11, subtarefa 1010, ~5 execuções por minuto), em vez de
 * escalar para o próximo modelo da cadeia do projeto.
 */
const MODEL_UNAVAILABLE_TEXT = /quota|rate[_ -]?limit|too many requests|exhausted|insufficient|billing|credits|token-plan|model not found|modelo indispon[ií]vel|model unavailable|model not allowed|no api key|missing api key|provider auth|invalid api key|authentication error|unauthorized|\b(429|401|403|404|422)\b/i

/** Mesma decisão de `isModelUnavailableError`, para falhas que chegam como texto. */
export function isModelUnavailableFailure(code: string, message: string): boolean {
  return MODEL_UNAVAILABLE_TEXT.test(`${code} ${message}`)
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
  // `generation` é a entrega persistida da subtarefa. Incluí-la na chave é
  // obrigatório: uma nova tentativa recebe outro worktree e não pode reutilizar
  // uma sessão criada com o cwd de uma tentativa anterior.
  return `${phase}-${slug}-${input.taskId}${input.subtaskId ? `-s${input.subtaskId}` : ""}-g${input.generation}`
}
