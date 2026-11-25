/**
 * Cálculo da próxima geração do motor de recorrência (função pura).
 *
 * Sem Nest, sem DB, sem I/O: recebe a regra (linha de `regras_recorrencia`
 * nos formatos do CRUD genérico — datas "YYYY-MM-DD", hora "HH:MM:SS") e um
 * `desde: Date` injetado (relógio do chamador) e devolve a próxima
 * ocorrência, ou `null` quando a regra está encerrada.
 *
 * Semântica (aceite — macro 4, subtarefa 1):
 * - diária: todo dia na `horaDoDia`, a partir de `dataInicio`;
 * - semanal: somente nos dias de `diasSemana` (0–6, 0 = domingo) na `horaDoDia`;
 * - mensal: 1 ocorrência por mês, no dia de `dataInicio`, com clamp ao último
 *   dia do mês quando o dia não existe (ex.: dia 31 em fevereiro);
 * - `horaDoDia` NULL = 00:00;
 * - idempotência: a ocorrência é ESTRICTAMENTE posterior a `desde` — reavaliar
 *   no próprio instante de geração não duplica (o agendador usa `proximaGeracao`
 *   como cursor; restart não gera duas instâncias para o mesmo ciclo);
 * - `dataFim` NULL = geração contínua; preenchida = a última ocorrência é a do
 *   próprio dia de `dataFim` (ou do clamp mensal nesse dia); ocorrência
 *   posterior a `dataFim` retorna `null` (encerramento).
 *
 * Datas são trabalhadas em horário LOCAL do processo (construtores locais de
 * `Date`); a suíte raiz roda com TZ=UTC (vitest.config.ts).
 */
import type { RegraRecorrencia } from "./tipos"

/** Desfaz "YYYY-MM-DD" → `Date` à meia-noite LOCAL. */
function parseDataLocal(iso: string): Date {
  const [ano, mes, dia] = iso.split("-").map(Number)
  return new Date(ano, mes - 1, dia)
}

/** Desfaz "HH:MM:SS" (ou "HH:MM") → componentes; NULL/vazio = 00:00. */
function parseHora(iso: string | null): { h: number; m: number; s: number } {
  if (!iso) return { h: 0, m: 0, s: 0 }
  const partes = iso.split(":").map(Number)
  return { h: partes[0] ?? 0, m: partes[1] ?? 0, s: partes[2] ?? 0 }
}

function inicioDoDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function adicionarDias(d: Date, dias: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dias)
}

/** Última data do mês de (ano, mes0): `Date(ano, mes0+1, 0)` = último dia. */
function ultimoDiaDoMes(ano: number, mes0: number): number {
  return new Date(ano, mes0 + 1, 0).getDate()
}

/**
 * Encerramento: ocorrência cujo dia ultrapassa `dataFim` → `null`.
 * Dia da ocorrência (meia-noite local) comparado com `dataFim` (meia-noite).
 */
function encerrada(t: Date, dataFim: string | null): Date | null {
  if (dataFim !== null && inicioDoDia(t) > parseDataLocal(dataFim)) return null
  return t
}

/**
 * Próxima geração da regra a partir de `desde`.
 *
 * @param regra linha de `regras_recorrencia` (validada por `validarRegra`).
 * @param desde cursor do chamador (agora do agendador ou `proximaGeracao`
 * atual); a ocorrência retornada é estritamente posterior a `desde`.
 * @returns próxima ocorrência em horário local, ou `null` (encerrada / sem
 * dia da semana selecionado — impossível após validação).
 */
export function calcularProximaGeracao(regra: RegraRecorrencia, desde: Date): Date | null {
  const inicio = parseDataLocal(regra.dataInicio)
  const hora = parseHora(regra.horaDoDia)

  if (regra.frequencia === "diaria") {
    // Primeiro dia em {dataInicio, dia(desde)} com horário na `horaDoDia`,
    // estritamente depois de `desde`.
    let dia = inicioDoDia(desde)
    if (dia < inicio) dia = inicio
    let ocorrencia = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hora.h, hora.m, hora.s)
    if (ocorrencia <= desde) {
      dia = adicionarDias(dia, 1)
      ocorrencia = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hora.h, hora.m, hora.s)
    }
    return encerrada(ocorrencia, regra.dataFim)
  }

  if (regra.frequencia === "semanal") {
    const dias = new Set(regra.diasSemana ?? [])
    let dia = inicioDoDia(desde)
    if (dia < inicio) dia = inicio
    // No máximo 8 iterações: `dias` não vazia garante acerto em ≤7 dias.
    for (let i = 0; i < 8; i++) {
      if (dias.has(dia.getDay())) {
        const ocorrencia = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hora.h, hora.m, hora.s)
        if (ocorrencia > desde) return encerrada(ocorrencia, regra.dataFim)
      }
      dia = adicionarDias(dia, 1)
    }
    return null
  }

  // mensal: 1 por mês, no dia de `dataInicio`, com clamp ao último dia do mês.
  const diaInicio = inicio.getDate()
  const base = inicioDoDia(desde)
  const fimMes = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  const diaNoMesDesde = Math.min(diaInicio, fimMes)
  // Se o clamp do mês corrente é ANTERIOR ao dia real no mês (ex.: desde no
  // dia 28/02 com diaInicio 31), a ocorrência do mês corrente já passou —
  // começar no próximo mês evita falso acerto.
  let ano = base.getFullYear()
  let mes0 = base.getMonth()
  const primeiroDiaCandidato = new Date(ano, mes0, diaNoMesDesde)
  if (primeiroDiaCandidato < base) {
    mes0 += 1
    if (mes0 > 11) {
      mes0 = 0
      ano += 1
    }
  }
  if (inicioDoDia(new Date(ano, mes0, 1)) < inicio) {
    ano = inicio.getFullYear()
    mes0 = inicio.getMonth()
  }
  for (let i = 0; i < 24; i++) {
    const ultimo = ultimoDiaDoMes(ano, mes0)
    const dia = Math.min(diaInicio, ultimo)
    const ocorrencia = new Date(ano, mes0, dia, hora.h, hora.m, hora.s)
    if (ocorrencia > desde) return encerrada(ocorrencia, regra.dataFim)
    mes0 += 1
    if (mes0 > 11) {
      mes0 = 0
      ano += 1
    }
  }
  return null
}
