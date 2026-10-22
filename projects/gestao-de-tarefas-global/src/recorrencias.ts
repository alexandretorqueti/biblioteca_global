/**
 * Contratos de domínio — recorrências e timezone global do sistema.
 *
 * Regras:
 * - Existe UMA configuração única de timezone do sistema (IANA), usada como
 *   referência para todos os cálculos de recorrência e prazos. O timezone
 *   local do servidor nunca é usado.
 * - Periodicidades suportadas: diária, semanal (múltiplos dias da semana),
 *   mensal e anual, sempre com horário de execução ("HH:MM" no timezone do
 *   sistema).
 * - Cada ocorrência programada tem identidade determinística derivada de
 *   (recorrenciaId, instante UTC da ocorrência) — reprocessamentos não
 *   duplicam ocorrências (chave única persistida em ocorrencias_recorrencias).
 */

export const FREQUENCIAS_RECORRENCIA = ["diaria", "semanal", "mensal", "anual"] as const
export type FrequenciaRecorrencia = (typeof FREQUENCIAS_RECORRENCIA)[number]

/** Dias da semana ISO-8601: 1 = segunda .. 7 = domingo. */
export const DIAS_SEMANA_ISO = [1, 2, 3, 4, 5, 6, 7] as const
export type DiaSemanaIso = (typeof DIAS_SEMANA_ISO)[number]

export const HORA_EXECUCAO_PADRAO = "09:00"

/** Regra de recorrência com parâmetros de calendário completos. */
export interface RegraRecorrencia {
  frequencia: FrequenciaRecorrencia
  /** Horário de execução "HH:MM", interpretado no timezone do sistema. */
  horaExecucao: string
  /** Obrigatório para semanal: um ou mais dias ISO (1..7), sem duplicatas. */
  diasSemana?: DiaSemanaIso[]
  /** Obrigatório para mensal e anual: dia do mês (1..31). */
  diaMes?: number
  /** Obrigatório para anual: mês (1..12). */
  mes?: number
}

/** Configuração única do sistema (linha única em configuracao_sistema). */
export interface ConfiguracaoSistema {
  /** Timezone IANA (ex.: "America/Sao_Paulo"). */
  timezone: string
}

export type ResultadoValidacao<T> =
  | { ok: true; valor: T }
  | { ok: false; erros: string[] }

const HORA_EXECUCAO_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const CHAVE_OCORRENCIA_MAX = 160

/** Valida se um identificador é um timezone IANA reconhecido pelo runtime. */
export function isTimezoneIana(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false
  const tz = candidate.trim()
  if (tz.length === 0 || tz.length > 64) return false
  try {
    // Intl lança RangeError para timezone desconhecido.
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Valida a configuração única do sistema (timezone IANA obrigatório). */
export function validarConfiguracaoSistema(input: unknown): ResultadoValidacao<ConfiguracaoSistema> {
  const erros: string[] = []
  if (typeof input !== "object" || input === null) {
    return { ok: false, erros: ["configuração deve ser um objeto"] }
  }
  const raw = input as Record<string, unknown>
  if (!isTimezoneIana(raw.timezone)) {
    erros.push("timezone deve ser um identificador IANA válido (ex.: America/Sao_Paulo)")
  }
  if (erros.length > 0) return { ok: false, erros }
  return { ok: true, valor: { timezone: (raw.timezone as string).trim() } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseInteiro(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return null
}

/**
 * Valida e normaliza uma regra de recorrência. Garante que os parâmetros de
 * calendário (frequência + horário + dias) são suficientes para calcular a
 * próxima ocorrência sem depender do timezone local do servidor.
 */
export function validarRegraRecorrencia(input: unknown): ResultadoValidacao<RegraRecorrencia> {
  const erros: string[] = []
  if (!isRecord(input)) {
    return { ok: false, erros: ["regra deve ser um objeto"] }
  }

  const frequencia = input.frequencia
  if (typeof frequencia !== "string" || !(FREQUENCIAS_RECORRENCIA as readonly string[]).includes(frequencia)) {
    return {
      ok: false,
      erros: [`frequência deve ser uma de: ${FREQUENCIAS_RECORRENCIA.join(", ")}`],
    }
  }
  const freq = frequencia as FrequenciaRecorrencia

  const horaExecucao = typeof input.horaExecucao === "string" ? input.horaExecucao.trim() : ""
  if (!HORA_EXECUCAO_RE.test(horaExecucao)) {
    erros.push('horaExecucao deve estar no formato "HH:MM" (00:00–23:59)')
  }

  let diasSemana: DiaSemanaIso[] | undefined
  let diaMes: number | undefined
  let mes: number | undefined

  if (freq === "semanal") {
    const rawDias = Array.isArray(input.diasSemana)
      ? input.diasSemana
      : typeof input.diasSemana === "string"
        ? input.diasSemana.split(",").map((d) => d.trim()).filter((d) => d.length > 0)
        : null
    if (!Array.isArray(rawDias) || rawDias.length === 0) {
      erros.push("semanal exige diasSemana com pelo menos um dia (1=segunda..7=domingo)")
    } else {
      const normalizados: DiaSemanaIso[] = []
      for (const dia of rawDias) {
        const n = parseInteiro(dia)
        if (n === null || !(DIAS_SEMANA_ISO as readonly number[]).includes(n)) {
          erros.push(`dia da semana inválido: ${String(dia)} (use 1..7)`)
        } else if (!normalizados.includes(n as DiaSemanaIso)) {
          normalizados.push(n as DiaSemanaIso)
        }
      }
      if (normalizados.length > 0 && erros.length === 0) {
        diasSemana = normalizados.slice().sort((a, b) => a - b)
      }
    }
  }

  if (freq === "mensal" || freq === "anual") {
    const n = parseInteiro(input.diaMes)
    if (n === null || n < 1 || n > 31) {
      erros.push(`${freq} exige diaMes entre 1 e 31`)
    } else {
      diaMes = n
    }
  }

  if (freq === "anual") {
    const m = parseInteiro(input.mes)
    if (m === null || m < 1 || m > 12) {
      erros.push("anual exige mes entre 1 e 12")
    } else {
      mes = m
    }
  }

  if (erros.length > 0) return { ok: false, erros }

  const valor: RegraRecorrencia = { frequencia: freq, horaExecucao }
  if (diasSemana !== undefined) valor.diasSemana = diasSemana
  if (diaMes !== undefined) valor.diaMes = diaMes
  if (mes !== undefined) valor.mes = mes
  return { ok: true, valor }
}

/**
 * Identidade determinística de uma ocorrência programada.
 *
 * Derivada exclusivamente de (recorrenciaId, instante UTC da ocorrência):
 * o mesmo par sempre produz a mesma chave, independentemente de quando ou
 * quantas vezes o processamento rodar — a unicidade persistida impede
 * duplicação em reprocessamentos.
 *
 * Formato: `rec-<recorrenciaId>-<yyyyMMddTHHmmssZ>` (UTC).
 */
export function chaveOcorrenciaDeterministica(
  recorrenciaId: number | string,
  ocorrenciaEm: Date | string,
): string {
  const id = typeof recorrenciaId === "string" ? recorrenciaId.trim() : String(recorrenciaId)
  if (id.length === 0) {
    throw new Error("recorrenciaId é obrigatório para gerar a chave da ocorrência")
  }
  const instante = ocorrenciaEm instanceof Date ? ocorrenciaEm : new Date(ocorrenciaEm)
  if (Number.isNaN(instante.getTime())) {
    throw new Error("ocorrenciaEm deve ser uma data/hora válida")
  }
  const utcCompacto = instante.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const chave = `rec-${id}-${utcCompacto}`
  if (chave.length > CHAVE_OCORRENCIA_MAX) {
    throw new Error("chave de ocorrência excede o tamanho persistível (160)")
  }
  return chave
}

/**
 * Converte dias ISO (1=seg..7=dom) para dias JS Date (0=dom..6=sáb),
 * utilitário para cálculo da próxima ocorrência semanal.
 */
export function diaIsoParaJs(diaIso: DiaSemanaIso): number {
  return diaIso % 7
}

export interface TarefaRecorrente {
  id: number
  areaId: number
  recorrenciaId?: number | null
  criadoPorId: number
  titulo: string
  descricao?: string | null
  prioridade?: "baixa" | "normal" | "alta" | "urgente"
  prazo?: Date | null
  createdAt?: Date
  responsavelId?: number | null
  tagIds?: number[]
  /** Apenas para deixar explícito que anexos não fazem parte da cópia. */
  anexos?: unknown[]
}

export type StatusTarefaRecorrente = "aberta" | "em_andamento" | "aguardando" | "concluida" | "cancelada"

export interface OcorrenciaRecorrente {
  id?: number
  recorrenciaId: number
  tarefaBaseId: number
  tarefaGeradaId?: number | null
  ocorrenciaEm: Date
  chave: string
  status: "programada" | "gerada" | "cancelada"
}

export interface NovaTarefaRecorrente {
  areaId: number
  recorrenciaId: number
  criadoPorId: number
  titulo: string
  descricao: string | null
  prioridade: "baixa" | "normal" | "alta" | "urgente"
  prazo: Date | null
  responsavelId: number | null
  tagIds: number[]
  ocorrenciaEm: Date
}

/** Retorna as partes do calendário no timezone global, sem usar o timezone do servidor. */
function partesNoTimezone(instante: Date, timezone: string): { ano: number; mes: number; dia: number; hora: number; minuto: number; segundo: number } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instante)
  const valor = (tipo: string) => Number(partes.find((parte) => parte.type === tipo)?.value)
  return { ano: valor("year"), mes: valor("month"), dia: valor("day"), hora: valor("hour"), minuto: valor("minute"), segundo: valor("second") }
}

function dataCalendarioUtc(ano: number, mes: number, dia: number, hora: number, minuto: number): number {
  return Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0)
}

/** Converte um horário civil no timezone global para o instante UTC correspondente. */
function instanteNoTimezone(ano: number, mes: number, dia: number, hora: number, minuto: number, timezone: string): Date {
  const civil = dataCalendarioUtc(ano, mes, dia, hora, minuto)
  let candidato = civil
  for (let i = 0; i < 3; i += 1) {
    const local = partesNoTimezone(new Date(candidato), timezone)
    const localComoUtc = dataCalendarioUtc(local.ano, local.mes, local.dia, local.hora, local.minuto)
    candidato = civil - (localComoUtc - candidato)
  }
  return new Date(candidato)
}

function adicionarDias(ano: number, mes: number, dia: number, quantidade: number): [number, number, number] {
  const d = new Date(Date.UTC(ano, mes - 1, dia + quantidade))
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}

/**
 * Calcula a primeira ocorrência estritamente posterior a `agora`.
 * A comparação e a construção do horário ocorrem no timezone configurado;
 * o resultado é um Date UTC para persistência.
 */
export function calcularPrimeiraOcorrenciaFutura(regra: RegraRecorrencia, timezone: string, agora: Date = new Date()): Date {
  const validacao = validarRegraRecorrencia(regra)
  if (!validacao.ok) throw new Error(validacao.erros.join("; "))
  if (!isTimezoneIana(timezone)) throw new Error(`timezone inválido: ${timezone}`)
  if (Number.isNaN(agora.getTime())) throw new Error("agora deve ser uma data válida")

  const localAgora = partesNoTimezone(agora, timezone)
  const dias = regra.frequencia === "diaria" ? 3700 : regra.frequencia === "semanal" ? 3700 : regra.frequencia === "mensal" ? 3700 : 37000
  for (let deslocamento = 0; deslocamento <= dias; deslocamento += 1) {
    const [ano, mes, dia] = adicionarDias(localAgora.ano, localAgora.mes, localAgora.dia, deslocamento)
    const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay() || 7
    const corresponde = regra.frequencia === "diaria"
      || (regra.frequencia === "semanal" && regra.diasSemana?.includes(diaSemana as DiaSemanaIso))
      || ((regra.frequencia === "mensal" || regra.frequencia === "anual") && dia === regra.diaMes && (regra.frequencia !== "anual" || mes === regra.mes))
    if (!corresponde) continue
    // Datas inexistentes (ex.: 31/02) são simplesmente puladas.
    if (regra.frequencia !== "diaria" && regra.frequencia !== "semanal" && dia !== regra.diaMes) continue
    const [hora, minuto] = regra.horaExecucao.split(":").map(Number) as [number, number]
    const candidato = instanteNoTimezone(ano, mes, dia, hora, minuto, timezone)
    if (candidato.getTime() > agora.getTime()) return candidato
  }
  throw new Error("não foi possível calcular a próxima ocorrência no limite suportado")
}

export interface RepositorioRecorrencias {
  buscarTarefaBase(recorrenciaId: number): Promise<TarefaRecorrente | null>
  buscarTarefaAtiva(recorrenciaId: number): Promise<TarefaRecorrente | null>
  buscarRegra(recorrenciaId: number): Promise<RegraRecorrencia | null>
  buscarOuCriarOcorrencia(ocorrencia: OcorrenciaRecorrente): Promise<OcorrenciaRecorrente>
  criarTarefa(dados: NovaTarefaRecorrente): Promise<{ id: number }>
  marcarOcorrenciaGerada(chave: string, tarefaGeradaId: number): Promise<void>
}

/** Um status aguardando continua ativo e, portanto, bloqueia novo ciclo. */
export function tarefaRecorrenteAtiva(status: StatusTarefaRecorrente): boolean {
  return status === "aberta" || status === "em_andamento" || status === "aguardando"
}

/**
 * Processa uma recorrência de forma idempotente. O repositório deve implementar
 * `buscarOuCriarOcorrencia` como INSERT ... ON CONFLICT(chave), idealmente na
 * mesma transação da criação da tarefa, para suportar dois workers concorrentes.
 */
export class ProcessadorRecorrencias {
  constructor(private readonly repositorio: RepositorioRecorrencias, private readonly timezone: string) {}

  async processar(recorrenciaId: number, agora: Date = new Date()): Promise<{ criada: boolean; ocorrencia: OcorrenciaRecorrente | null; tarefaId?: number }> {
    const base = await this.repositorio.buscarTarefaBase(recorrenciaId)
    if (!base) return { criada: false, ocorrencia: null }
    const ativa = await this.repositorio.buscarTarefaAtiva(recorrenciaId)
    if (ativa) return { criada: false, ocorrencia: null }

    // A ocorrência é sempre calculada a partir de agora: nunca há criação retroativa.
    const regra = await this.repositorio.buscarRegra(recorrenciaId)
    if (!regra) return { criada: false, ocorrencia: null }
    const ocorrenciaEm = calcularPrimeiraOcorrenciaFutura(regra, this.timezone, agora)
    const ocorrencia = await this.repositorio.buscarOuCriarOcorrencia({
      recorrenciaId, tarefaBaseId: base.id, ocorrenciaEm,
      chave: chaveOcorrenciaDeterministica(recorrenciaId, ocorrenciaEm), status: "programada",
    })
    if (ocorrencia.status === "gerada" || ocorrencia.tarefaGeradaId != null) return { criada: false, ocorrencia }

    const tarefa = await this.repositorio.criarTarefa({
      areaId: base.areaId, recorrenciaId, criadoPorId: base.criadoPorId, titulo: base.titulo,
      descricao: base.descricao ?? null, prioridade: base.prioridade ?? "normal",
      prazo: base.prazo && base.createdAt ? new Date(ocorrenciaEm.getTime() + base.prazo.getTime() - base.createdAt.getTime()) : ocorrenciaEm,
      responsavelId: base.responsavelId ?? null, tagIds: [...(base.tagIds ?? [])], ocorrenciaEm,
    })
    await this.repositorio.marcarOcorrenciaGerada(ocorrencia.chave, tarefa.id)
    return { criada: true, ocorrencia: { ...ocorrencia, status: "gerada", tarefaGeradaId: tarefa.id }, tarefaId: tarefa.id }
  }

}
