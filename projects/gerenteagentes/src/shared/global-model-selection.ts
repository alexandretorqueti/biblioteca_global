/**
 * Contrato da configuração global de modelos.
 *
 * Este contrato é deliberadamente estrito: a configuração global só pode
 * conter as três filas conhecidas e nenhum campo implícito. A validação deve
 * ocorrer antes de qualquer persistência ou propagação.
 */

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

export type GlobalModelSelectionProjectApplied = {
  projectKey: string
  tipos: GlobalModelSelectionTipo[]
}

export type GlobalModelSelectionProjectError = {
  projectKey: string
  error: string
}

/** Resposta que separa o estado global do resultado por projeto. */
export type GlobalModelSelectionPropagationResponse = {
  configuracaoGlobal: GlobalModelSelection
  resultadoPropagacao: {
    sucesso: boolean
    totalProjetos: number
  }
  projetosAplicados: GlobalModelSelectionProjectApplied[]
  errosPorProjeto: GlobalModelSelectionProjectError[]
}

export class GlobalModelSelectionValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Configuração global de modelos inválida: ${issues.join("; ")}`)
    this.name = "GlobalModelSelectionValidationError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function validateEntry(value: unknown, path: string, issues: string[]): value is GlobalModelSelectionEntry {
  if (!isRecord(value)) {
    issues.push(`${path} deve ser um objeto`)
    return false
  }
  if (!hasExactlyKeys(value, ["ordem", "provider", "model", "enabled"])) {
    issues.push(`${path} contém campos ausentes ou extras`)
  }
  if (!Number.isSafeInteger(value.ordem) || (typeof value.ordem === "number" && value.ordem <= 0)) issues.push(`${path}.ordem deve ser inteiro positivo`)
  if (typeof value.provider !== "string" || value.provider.trim() === "") issues.push(`${path}.provider não pode ser vazio`)
  if (typeof value.model !== "string" || value.model.trim() === "") issues.push(`${path}.model não pode ser vazio`)
  if (typeof value.enabled !== "boolean") issues.push(`${path}.enabled deve ser booleano`)
  return issues.length === 0
}

/** Valida e devolve uma configuração pronta para ser persistida. */
export function parseGlobalModelSelection(input: unknown): GlobalModelSelection {
  const issues: string[] = []
  if (!isRecord(input)) throw new GlobalModelSelectionValidationError(["configuração deve ser um objeto"])
  if (!hasExactlyKeys(input, GLOBAL_MODEL_SELECTION_TYPES)) issues.push("configuração deve conter exatamente DEV, ANALYST e MONITOR")

  for (const tipo of GLOBAL_MODEL_SELECTION_TYPES) {
    const fila = input[tipo]
    if (!Array.isArray(fila) || fila.length === 0) {
      issues.push(`${tipo} deve conter ao menos uma entrada`)
      continue
    }
    fila.forEach((entry, index) => validateEntry(entry, `${tipo}[${index}]`, issues))
  }

  if (issues.length > 0) throw new GlobalModelSelectionValidationError(issues)
  return input as unknown as GlobalModelSelection
}

export function isGlobalModelSelection(input: unknown): input is GlobalModelSelection {
  try {
    parseGlobalModelSelection(input)
    return true
  } catch {
    return false
  }
}
