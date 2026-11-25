/**
 * Validação de regra de recorrência (função pura).
 *
 * Roda no backend ANTES de criar/atualizar `regras_recorrencia` e antes de
 * qualquer `calcularProximaGeracao` — o agendador nunca processa regra
 * inválida. Mensagens objetivas (pt-BR), sem embalar em erros de framework.
 */
import type { RegraRecorrencia } from "./tipos"

/** Resultado da validação: lista vazia = regra válida. */
export type ErrosValidacaoRegra = string[]

function validarDiasSemana(regra: RegraRecorrencia): string[] {
  const dias = regra.diasSemana
  if (regra.frequencia !== "semanal") return []
  if (dias === null || !Array.isArray(dias) || dias.length === 0) {
    return ["diasSemana é obrigatório e não pode ser vazio para frequência semanal"]
  }
  const invalidos = dias.filter((d) => !Number.isInteger(d) || d < 0 || d > 6)
  if (invalidos.length > 0) {
    return [
      `diasSemana deve conter apenas inteiros de 0 a 6 (0 = domingo); inválidos: ${invalidos.join(", ")}`,
    ]
  }
  return []
}

function validarDatas(regra: RegraRecorrencia): string[] {
  const erros: string[] = []
  if (regra.dataInicio === null || regra.dataInicio === undefined || regra.dataInicio === "") {
    erros.push("dataInicio é obrigatória")
    return erros
  }
  if (regra.dataFim !== null && regra.dataFim !== undefined && regra.dataFim < regra.dataInicio) {
    erros.push(`dataFim (${regra.dataFim}) não pode ser anterior a dataInicio (${regra.dataInicio})`)
  }
  return erros
}

/**
 * Valida a regra; retorna a lista de erros (vazia = válida).
 *
 * Regras:
 * - semanal exige `diasSemana` não vazia com inteiros 0–6;
 * - `dataInicio` obrigatória;
 * - `dataFim` (quando presente) ≥ `dataInicio`.
 */
export function validarRegra(regra: RegraRecorrencia): string[] {
  return [...validarDatas(regra), ...validarDiasSemana(regra)]
}
