/**
 * Falhas idênticas em modelos distintos tendem a ser problema de ambiente,
 * repositório ou gate — não de capacidade do modelo. A normalização remove
 * trechos voláteis para evitar escalar indefinidamente por um erro sistêmico.
 */
export function failureFingerprint(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

export function isSystemicFailure(modelFailures: readonly string[]): boolean {
  if (modelFailures.length < 2) return false
  const fingerprints = modelFailures.map(failureFingerprint).filter(Boolean)
  return fingerprints.length >= 2 && new Set(fingerprints).size === 1
}
