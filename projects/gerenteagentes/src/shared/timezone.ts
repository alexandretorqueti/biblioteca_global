/**
 * Utilitários compartilhados de fuso horário.
 *
 * Usado pelo catálogo de configurações (validação), pela API (leitura do valor
 * efetivo) e pelas telas operacionais (seletor de fusos e formatação).
 *
 * O identificador padrão é `America/Sao_Paulo` — confirmado pelo usuário como
 * fallback quando não há valor persistido.
 */

/** Fuso horário padrão do sistema quando nenhum valor está persistido. */
export const DEFAULT_TIMEZONE = "America/Sao_Paulo"

/**
 * Valida se o valor é um identificador IANA de fuso horário reconhecido pelo
 * runtime (Intl.DateTimeFormat). Rejeita strings vazias, null, undefined e
 * identificadores que o engine não reconhece.
 */
export function isValidTimezone(valor: unknown): valor is string {
  if (typeof valor !== "string" || valor.length === 0) return false
  try {
    Intl.DateTimeFormat("en-US", { timeZone: valor })
    return true
  } catch {
    return false
  }
}

/**
 * Retorna a lista de identificadores IANA suportados pelo runtime.
 * Usa `Intl.supportedValuesOf("timeZone")` (Node 18+, Chrome 99+, Firefox 143+).
 * Quando indisponível, retorna uma lista mínima de fallback.
 */
export function getSupportedTimezones(): string[] {
  if (typeof Intl !== "undefined" && typeof (Intl as any).supportedValuesOf === "function") {
    try {
      const values = (Intl as any).supportedValuesOf("timeZone") as string[]
      if (Array.isArray(values) && values.length > 0) return values
    } catch {
      // fallback abaixo
    }
  }
  // Fallback: subconjunto estável cobrindo os fusos mais comuns.
  return [
    "America/Sao_Paulo", "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/Toronto", "America/Vancouver", "America/Bogota",
    "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires",
    "America/Mexico_City", "America/Phoenix", "America/Anchorage",
    "Pacific/Honolulu", "Pacific/Auckland", "Pacific/Fiji",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
    "Europe/Rome", "Europe/Amsterdam", "Europe/Brussels", "Europe/Zurich",
    "Europe/Lisbon", "Europe/Dublin", "Europe/Athens", "Europe/Istanbul",
    "Europe/Moscow", "Europe/Warsaw", "Europe/Prague", "Europe/Stockholm",
    "Europe/Oslo", "Europe/Copenhagen", "Europe/Helsinki",
    "Asia/Tokyo", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore",
    "Asia/Seoul", "Asia/Kolkata", "Asia/Dubai", "Asia/Bangkok",
    "Asia/Jakarta", "Asia/Taipei", "Asia/Manila", "Asia/Karachi",
    "Asia/Riyadh", "Asia/Tehran", "Asia/Baghdad", "Asia/Jerusalem",
    "Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi",
    "Australia/Sydney", "Australia/Melbourne", "Australia/Perth",
    "Australia/Brisbane", "Australia/Adelaide",
    "Atlantic/Reykjavik", "Atlantic/Azores",
    "Indian/Maldives", "Indian/Mauritius",
    "UTC",
  ]
}

/**
 * Retorna o fuso horário efetivo: o valor persistido se válido, ou o padrão.
 * Útil para telas e serviços que precisam do valor resolvido sem conhecer
 * a origem (banco vs. default).
 */
export function resolveTimezone(persistido: unknown): string {
  return isValidTimezone(persistido) ? persistido : DEFAULT_TIMEZONE
}
