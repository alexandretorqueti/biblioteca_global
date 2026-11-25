/**
 * Tipos do domínio de recorrência (funções puras — sem Nest, sem DB).
 *
 * Espelham as linhas de `regras_recorrencia` (schema.ts) nos formatos em que
 * o CRUD genérico as trafega: datas como string ISO ("YYYY-MM-DD"), hora como
 * string "HH:MM:SS" e `diasSemana` como JSON (número 0–6, 0 = domingo —
 * mesmo índice de `Date.getDay()`).
 */

/** Frequências suportadas pelo motor de recorrência (enum do schema). */
export type Frequencia = "diaria" | "semanal" | "mensal"

export interface RegraRecorrencia {
  id: number
  organizacaoId: number
  titulo: string
  descricao: string | null
  areaId: number
  responsavelId: number
  frequencia: Frequencia
  /** NULL fora da frequência semanal; obrigatória (não vazia) quando semanal. */
  diasSemana: number[] | null
  /** NULL = 00:00. */
  horaDoDia: string | null
  /** "YYYY-MM-DD" (local). */
  dataInicio: string
  /** "YYYY-MM-DD" (local); NULL = geração contínua (sem fim). */
  dataFim: string | null
  ativa: boolean
  proximaGeracao: string | null
}
