/**
 * CarryOverPolicy — aprendizado entre entregas (P1, 2026-09-05).
 *
 * Problema (investigação tarefa 760): cada entrega cria sessão nova e o único
 * carry-over era o output bruto do gate, truncado — nas entregas 3-4 o agente
 * recebeu HTML de componente MUI como "erro", sem a linha real da asserção.
 * Nenhum aprendizado da tentativa anterior ("já tentei X, falhou por Y") era
 * passado adiante.
 *
 * Solução:
 * - `digestGateFailure`: extrai as linhas relevantes da falha (asserções,
 *   nomes de teste, erros de compilação) e descarta ruído (HTML, stack
 *   interno de bibliotecas), mantendo um resumo curto e acionável.
 * - `formatCarryOver`: formata o histórico de entregas persistido
 *   (subtarefas_entregas) como seção estruturada do prompt do programador.
 */

/** Linha relevante de output de falha de gate (teste/build). */
const IMPORTANT_LINE =
  /(FAIL\b|failed\b|✕|×|❯|AssertionError|AssertError|Error:|error TS\d+|expected|received|TypeError|ReferenceError|SyntaxError|RangeError|Cannot find|command not found|ENOENT|ECONNREFUSED|Tests? +\d+|\d+ (failed|passed)|✗|⎯|stderr:|npm ERR!)/i

/** Ruído conhecido: linhas de markup/HTML que poluem o output de testes de componente. */
const NOISE_LINE = /^\s*(<[^>]+>|\{\/\*|\/\*|\*\/|<\/?[a-zA-Z][\s\S]*>)\s*$/

const DEFAULT_DIGEST_LINES = 40
const DEFAULT_DIGEST_CHARS = 6000
const FALLBACK_TAIL_LINES = 12

/**
 * Reduz a saída de uma falha de gate às linhas que importam.
 *
 * Estratégia:
 * 1. Mantém linhas que casam com padrões de falha (asserções, erros, resumo
 *    do runner), removendo duplicatas consecutivas e ruído de markup.
 * 2. Se o filtro produzir pouco material (< 3 linhas), anexa o final da
 *    saída (runners imprimem o resumo por último).
 * 3. Limita linhas e caracteres — o digest vai dentro do prompt.
 */
export function digestGateFailure(
  output: string,
  options?: { maxLines?: number; maxChars?: number },
): string {
  const maxLines = options?.maxLines ?? DEFAULT_DIGEST_LINES
  const maxChars = options?.maxChars ?? DEFAULT_DIGEST_CHARS
  const raw = (output || "").replace(/\r/g, "")
  if (!raw.trim()) return "(sem saída diagnóstica)"

  const lines = raw.split("\n")
  const important: string[] = []
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (!trimmed.trim()) continue
    if (NOISE_LINE.test(trimmed)) continue
    if (IMPORTANT_LINE.test(trimmed)) {
      // Evita rajadas de linhas idênticas (loops de render, repeats)
      if (important[important.length - 1] === trimmed) continue
      important.push(trimmed)
    }
  }

  let selected = important
  if (selected.length < 3) {
    // Pouco material filtrável: o final da saída é o melhor resumo disponível.
    const tail = lines.filter((line) => line.trim().length > 0).slice(-FALLBACK_TAIL_LINES)
    selected = tail.length > 0 ? tail : lines.slice(-FALLBACK_TAIL_LINES)
  }

  if (selected.length > maxLines) {
    const head = selected.slice(0, Math.floor(maxLines / 2))
    const tail = selected.slice(-Math.ceil(maxLines / 2))
    selected = [...head, `[... ${selected.length - maxLines } linha(s) omitida(s) ...]`, ...tail]
  }

  let digest = selected.join("\n").trim()
  if (digest.length > maxChars) {
    digest = digest.slice(0, maxChars) + "\n[... digest truncado ...]"
  }
  return digest || raw.slice(-maxChars)
}

/** Evento do histórico de entregas (linha de subtarefas_entregas). */
export interface CarryOverEvent {
  deliverNumber: number
  model: string | null
  eventType: string
  reason: string | null
}

const EVENT_LABELS: Record<string, string> = {
  delivery_started: "entrega iniciada",
  gate_rejected: "gate rejeitou",
  return_for_rework: "retorno para rework",
  blocked: "bloqueio",
  completed: "concluída",
  baseline_red: "baseline vermelho",
  integration_conflict: "conflito na integração com a branch da tarefa",
  integration_gate_failed: "gate de integração falhou após merge na branch da tarefa",
}

const RELEVANT_EVENTS = new Set([
  "gate_rejected",
  "return_for_rework",
  "blocked",
  "baseline_red",
  "integration_conflict",
  "integration_gate_failed",
])

const MAX_CARRY_OVER_EVENTS = 6
const REASON_DIGEST_CHARS = 1200
const MAX_CARRY_OVER_CHARS = 8000

/**
 * Formata o histórico de entregas como seção de aprendizado para o prompt.
 * Inclui apenas eventos com sinal (rejeições, bloqueios, rework) — o agente
 * precisa saber o que já foi tentado e por que falhou, sem repetir.
 */
export function formatCarryOver(events: readonly CarryOverEvent[]): string {
  const relevant = events.filter((event) => RELEVANT_EVENTS.has(event.eventType) && event.reason)
  if (relevant.length === 0) return ""
  const selected = relevant.slice(-MAX_CARRY_OVER_EVENTS)
  const lines = selected.map((event) => {
    const label = EVENT_LABELS[event.eventType] ?? event.eventType
    const model = event.model ? `, modelo ${event.model}` : ""
    const reason = digestGateFailure(event.reason!, { maxLines: 10, maxChars: REASON_DIGEST_CHARS })
    return `- Entrega ${event.deliverNumber}${model}: ${label} —\n${reason}`
  })
  let body = [
    "Histórico de entregas anteriores DESTA subtarefa (aprendizado — não repita abordagens que já falharam):",
    ...lines,
  ].join("\n")
  if (body.length > MAX_CARRY_OVER_CHARS) {
    body = body.slice(0, MAX_CARRY_OVER_CHARS) + "\n[... histórico truncado ...]"
  }
  return body
}
