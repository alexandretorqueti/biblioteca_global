export const GLOBAL_MODEL_SELECTION_TYPES = ["DEV", "ANALYST", "MONITOR"] as const
export type GlobalModelSelectionTipo = (typeof GLOBAL_MODEL_SELECTION_TYPES)[number]

export type GlobalModelSelectionEntry = {
  ordem: number
  provider: string
  model: string
  enabled: boolean
}

export type GlobalModelSelection = {
  DEV: GlobalModelSelectionEntry[]
  ANALYST: GlobalModelSelectionEntry[]
  MONITOR: GlobalModelSelectionEntry[]
}

export class GlobalModelSelectionValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Configuração global de modelos inválida: ${issues.join("; ")}`)
    this.name = "GlobalModelSelectionValidationError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseGlobalModelSelection(input: unknown): GlobalModelSelection {
  const issues: string[] = []
  if (!isRecord(input)) throw new GlobalModelSelectionValidationError(["configuração deve ser um objeto"])
  const keys = Object.keys(input)
  if (keys.length !== 3 || GLOBAL_MODEL_SELECTION_TYPES.some((tipo) => !keys.includes(tipo))) {
    issues.push("configuração deve conter exatamente DEV, ANALYST e MONITOR")
  }
  for (const tipo of GLOBAL_MODEL_SELECTION_TYPES) {
    const queue = input[tipo]
    if (!Array.isArray(queue) || queue.length === 0) {
      issues.push(`${tipo} deve conter ao menos uma entrada`)
      continue
    }
    queue.forEach((entry, index) => {
      if (!isRecord(entry)) {
        issues.push(`${tipo}[${index}] deve ser um objeto`)
        return
      }
      const entryKeys = Object.keys(entry)
      if (entryKeys.length !== 4 || ["ordem", "provider", "model", "enabled"].some((key) => !entryKeys.includes(key))) {
        issues.push(`${tipo}[${index}] contém campos ausentes ou extras`)
      }
      if (!Number.isSafeInteger(entry.ordem) || (typeof entry.ordem === "number" && entry.ordem <= 0)) issues.push(`${tipo}[${index}].ordem deve ser inteiro positivo`)
      if (typeof entry.provider !== "string" || entry.provider.trim() === "") issues.push(`${tipo}[${index}].provider não pode ser vazio`)
      if (typeof entry.model !== "string" || entry.model.trim() === "") issues.push(`${tipo}[${index}].model não pode ser vazio`)
      if (typeof entry.enabled !== "boolean") issues.push(`${tipo}[${index}].enabled deve ser booleano`)
    })
  }
  if (issues.length > 0) throw new GlobalModelSelectionValidationError(issues)
  return input as GlobalModelSelection
}
