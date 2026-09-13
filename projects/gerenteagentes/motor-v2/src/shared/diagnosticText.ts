/** Limite seguro para evidência persistida sem transformar a coluna em log infinito. */
export const MAX_DIAGNOSTIC_TEXT_LENGTH = 20_000

/** Resultado de subtarefa é evidência para diagnóstico, não um campo de UI. */
export function diagnosticText(value: unknown, fallback = ""): string {
  const text = value == null ? fallback : String(value)
  return text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)
}
