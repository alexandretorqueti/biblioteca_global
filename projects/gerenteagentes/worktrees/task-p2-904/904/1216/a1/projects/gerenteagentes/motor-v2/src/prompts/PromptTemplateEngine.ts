/**
 * Funções puras de composição de prompts administráveis.
 *
 * ⚠️ Este arquivo NÃO pode ter imports relativos: a API (apps/api, CJS via
 * @swc-node/register) consome este módulo diretamente do src. Imports com
 * extensão `.js` quebram o resolver CJS (MODULE_NOT_FOUND). O que precisa dos
 * catálogos vive em `ManagedPromptResolver.ts` (consumido só pelo Motor/dist).
 */
export const MARKER_PATTERN = /\*\*([A-Z][A-Z0-9_]*)\*\*/g

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
