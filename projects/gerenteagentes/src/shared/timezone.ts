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

/**
 * Formata um instante (ISO string, Date ou epoch ms) no fuso horário informado,
 * usando localidade pt-BR. Retorna string vazia para entrada inválida.
 *
 * Padrão: dia/mês/ano hora:minuto (ex.: "11/10/2026 10:30").
 */
export function formatarDataHora(
  valor: string | Date | number | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  opcoes?: Intl.DateTimeFormatOptions,
): string {
  if (valor == null || valor === "") return ""
  const date = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(date.getTime())) return ""
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const fmt: Intl.DateTimeFormatOptions = opcoes ?? {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }
  return date.toLocaleString("pt-BR", { ...fmt, timeZone: tz })
}

/**
 * Retorna a data civil "hoje" no fuso informado como string YYYY-MM-DD.
 * Útil para filtros de dia corrente e classificação de registros.
 */
export function hojeNoFuso(timezone: string = DEFAULT_TIMEZONE, agora: Date = new Date()): string {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return formatter.format(agora)
}

/**
 * Verifica se uma data ISO/Date corresponde ao dia civil "hoje" no fuso informado.
 * Respeita transições de offset e é segura perto da meia-noite.
 */
export function isHojeNoFuso(
  valor: string | Date | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  agora: Date = new Date(),
): boolean {
  if (valor == null || valor === "") return false
  const date = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(date.getTime())) return false
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return fmt.format(date) === fmt.format(agora)
}

/**
 * Converte um dia civil YYYY-MM-DD nos limites [inicio, fim) em UTC,
 * respeitando o fuso informado. Retorno como strings ISO completas
 * (YYYY-MM-DD HH:MM:SS) prontas para comparação com timestamps do banco
 * que são persistidos em UTC.
 *
 * Exemplo: dia "2026-10-11" em America/Sao_Paulo (UTC-3) →
 *   inicio = "2026-10-11 03:00:00" (meia-noite local em UTC)
 *   fim    = "2026-10-12 03:00:00"
 */
export function limitesDoDiaCivilUTC(
  dataYYYYMMDD: string,
  timezone: string = DEFAULT_TIMEZONE,
): { inicio: string; fim: string } {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const [ano, mes, dia] = dataYYYYMMDD.split("-").map(Number)
  // Constrói a data civil meia-noite no fuso e obtém o offset para UTC.
  const civilStr = `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}T00:00:00`
  const inicioLocal = zonedCivilToUTC(civilStr, tz)
  const diaSeguinte = new Date(ano!, (mes! - 1), dia! + 1)
  const seguinteStr = `${diaSeguinte.getFullYear()}-${String(diaSeguinte.getMonth() + 1).padStart(2, "0")}-${String(diaSeguinte.getDate()).padStart(2, "0")}T00:00:00`
  const fimLocal = zonedCivilToUTC(seguinteStr, tz)
  return { inicio: toSqlUtc(inicioLocal), fim: toSqlUtc(fimLocal) }
}

/** Converte uma data civil em um fuso para o instante UTC correspondente. */
function zonedCivilToUTC(civilISO: string, timezone: string): Date {
  // civilISO é algo como "2026-10-11T00:00:00" (sem fuso).
  // Queremos o instante UTC cuja projeção no fuso resulta nessa data/hora local.
  const asIfUTC = new Date(civilISO + "Z")
  const asIfMs = asIfUTC.getTime()

  // Descobre o offset do fuso nesse instante aproximado.
  // offsetMs = (representação do instante no fuso) - (representação UTC)
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(asIfUTC)
  const getTz = (t: string) => tzParts.find(p => p.type === t)?.value ?? "0"
  const tzMs = Date.UTC(
    Number(getTz("year")),
    Number(getTz("month")) - 1,
    Number(getTz("day")),
    Number(getTz("hour")) % 24,
    Number(getTz("minute")),
    Number(getTz("second")),
  )

  const utcParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(asIfUTC)
  const getUtc = (t: string) => utcParts.find(p => p.type === t)?.value ?? "0"
  const utcMs = Date.UTC(
    Number(getUtc("year")),
    Number(getUtc("month")) - 1,
    Number(getUtc("day")),
    Number(getUtc("hour")) % 24,
    Number(getUtc("minute")),
    Number(getUtc("second")),
  )

  const offsetMs = tzMs - utcMs
  // Instante UTC = civil menos o offset (ex.: offset=-3h → civil - (-3h) = civil + 3h)
  return new Date(asIfMs - offsetMs)
}

/** Formata Date em YYYY-MM-DD HH:MM:SS (UTC) para concatenação em SQL. */
function toSqlUtc(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0")
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0")
  const dd = d.getUTCDate().toString().padStart(2, "0")
  const hh = d.getUTCHours().toString().padStart(2, "0")
  const mi = d.getUTCMinutes().toString().padStart(2, "0")
  const ss = d.getUTCSeconds().toString().padStart(2, "0")
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}
