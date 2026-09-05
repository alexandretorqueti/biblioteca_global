export const MARKER_PATTERN = /\*\*([A-Z][A-Z0-9_]*)\*\*/g
import { AGENT_PROMPT_CATALOG } from "./prompt-catalog.js"
import { outputContractDefault } from "./output-contract-catalog.js"
import { BUNDLED_PROMPT_DEFAULTS } from "./prompt-defaults.generated.js"

export interface PromptQueryable { query(sql: string, params?: unknown[]): Promise<unknown> }

export interface PromptValidation {
  ok: boolean
  unknown: string[]
  missing: string[]
  used: string[]
}

export function markersIn(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER_PATTERN)].map((match) => `**${match[1]}**`))]
}

export function validatePromptTemplate(text: string, allowed: readonly string[], required: readonly string[] = []): PromptValidation {
  const used = markersIn(text)
  const allowedSet = new Set(allowed)
  const usedSet = new Set(used)
  const unknown = used.filter((marker) => !allowedSet.has(marker))
  const missing = required.filter((marker) => !usedSet.has(marker))
  return { ok: unknown.length === 0 && missing.length === 0, unknown, missing, used }
}

export function renderPromptTemplate(text: string, values: Record<string, unknown>): string {
  return text.replace(MARKER_PATTERN, (full) => {
    if (!(full in values)) throw new Error(`Máscara sem valor em runtime: ${full}`)
    const value = values[full]
    return typeof value === "string" ? value : JSON.stringify(value ?? "")
  })
}

function renderWithContract(text: string, values: Record<string, unknown>, instructions: string): string {
  const rendered = renderPromptTemplate(text, { ...values, "**CONTRATOSAIDA**": instructions })
  return instructions && !text.includes("**CONTRATOSAIDA**") ? `${rendered}\n\nCONTRATO DE SAÍDA OBRIGATÓRIO:\n${instructions}` : rendered
}

export class ManagedPromptResolver {
  constructor(private readonly db: PromptQueryable) {}

  async resolve(input: {
    key: string
    values: Record<string, unknown>
    fallback: string
    taskId?: string
    subtaskId?: number
  }): Promise<string> {
    let promptId: number | null = null
    let versionId: number | null = null
    let contractVersionId: number | null = null
    let fallbackUsed = true
    const catalogEntry = AGENT_PROMPT_CATALOG.find((entry) => entry.key === input.key)
    const embeddedContract = outputContractDefault(catalogEntry?.contractKey)
    const bundled = BUNDLED_PROMPT_DEFAULTS[input.key]
    const bundledFallback = bundled?.text ?? input.fallback
    const bundledInstructions = bundled?.contractInstructions ?? embeddedContract?.instructions ?? ""
    let output = bundledFallback
    try {
      const rawResult = await this.db.query(
        "SELECT p.id AS prompt_id, v.id AS version_id, v.texto, cv.id AS contract_version_id, cv.instrucoes FROM prompts_agentes p " +
        "INNER JOIN prompts_versoes v ON v.id = p.versao_ativa_id " +
        "LEFT JOIN prompts_contratos_versoes cv ON cv.id = v.contrato_versao_id " +
        "WHERE p.chave = ? AND p.status = 'active' LIMIT 1",
        [input.key],
      )
      const [rows] = rawResult as [Array<{ prompt_id: number; version_id: number; texto: string; contract_version_id: number | null; instrucoes: string | null }>, unknown]
      const row = rows[0]
      if (row) {
        promptId = Number(row.prompt_id)
        versionId = Number(row.version_id)
        contractVersionId = row.contract_version_id == null ? null : Number(row.contract_version_id)
        const contractInstructions = row.instrucoes ?? bundledInstructions
        output = renderWithContract(String(row.texto), input.values, contractInstructions)
        fallbackUsed = false
      }
      if (!row) output = renderWithContract(bundledFallback, input.values, bundledInstructions)
    } catch {
      // Fail-safe: tabela ausente, banco indisponível ou versão inválida não
      // pode interromper o Motor. O compositor embarcado continua funcional.
      output = renderWithContract(bundledFallback, input.values, bundledInstructions)
      fallbackUsed = true
    }
    await this.db.query(
      "INSERT INTO prompts_execucoes (prompt_id, versao_id, contrato_versao_id, chave, tarefa_id, subtarefa_id, fallback_usado, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
      [promptId, versionId, contractVersionId, input.key, input.taskId ?? null, input.subtaskId ?? null, fallbackUsed ? 1 : 0],
    ).catch(() => {})
    return output
  }
}
