/**
 * taskFlowHelpers.ts — funções puras para o Mapa Vivo da Operação.
 *
 * Helpers determinísticos para:
 * - Derivar prioridade a partir do status
 * - Formatar tempo relativo em português
 * - Gerar avatar de projeto (letra + cor)
 * - Calcular métricas consolidadas do mapa
 */

import { ALL_TASK_STATUSES } from "../motor-v2/src/shared/task-statuses"

// ============================================================================
// TIPOS
// ============================================================================

export type Prioridade = "alta" | "media" | "baixa"

export interface ProjetoAvatar {
  letra: string
  cor: string
}

export interface MetricasMapa {
  total: number
  emAndamento: number
  concluidasHoje: number
  bloqueadas: number
  tempoMedioExecucao: string
  porEstacao: Record<string, number>
}

export interface TarefaParaMetricas {
  id: number
  status: string
  projetoId: number
  createdAt?: string | null
  updatedAt?: string | null
}

// ============================================================================
// PRIORIDADE POR STATUS
// ============================================================================

/**
 * Mapeamento de prioridade por status de tarefa.
 * Cobre 100% dos ALL_TASK_STATUSES.
 *
 * Estratégia:
 * - alta: status que exigem ação imediata (blocked, failed, motor_fix)
 * - media: status em andamento ou aguardando (analyzing, running, paused, awaiting_clarification, ready)
 * - baixa: status finais ou iniciais (draft, planned, completed, deployed, cancelled, finalizada, deployada, aborted)
 */
export const PRIORIDADE_POR_STATUS: Record<string, Prioridade> = {
  // Status atuais (TASK_STATUSES)
  draft: "baixa",
  planned: "baixa",
  analyzing: "media",
  awaiting_clarification: "media",
  ready: "media",
  running: "media",
  paused: "media",
  completed: "baixa",
  deployed: "baixa",
  blocked: "alta",
  motor_fix: "alta",
  failed: "alta",
  cancelled: "baixa",
  // Status legados (TASK_STATUSES_LEGACY)
  finalizada: "baixa",
  deployada: "baixa",
  aborted: "baixa",
}

/**
 * Deriva a prioridade de uma tarefa a partir do status.
 * Retorna 'baixa' como fallback para status desconhecido.
 */
export function deriveTaskPriority(status: string): Prioridade {
  return PRIORIDADE_POR_STATUS[status] ?? "baixa"
}

// ============================================================================
// TEMPO RELATIVO
// ============================================================================

/**
 * Formata uma data ISO como tempo relativo em português brasileiro.
 *
 * Retornos possíveis:
 * - "agora" (menos de 1 minuto)
 * - "há Xmin" (minutos)
 * - "há Xh" (horas)
 * - "há Xd" (dias)
 * - "—" (data inválida ou ausente)
 *
 * Usa Intl.RelativeTimeFormat para formatação consistente.
 */
export function formatTempoRelativo(
  data?: string | null,
  agora: Date = new Date()
): string {
  if (!data) return "—"

  const dataObj = new Date(data)
  if (isNaN(dataObj.getTime())) return "—"

  const diffMs = agora.getTime() - dataObj.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHoras = Math.floor(diffMin / 60)
  const diffDias = Math.floor(diffHoras / 24)

  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "always" })

  if (diffMin < 1) return "agora"
  if (diffMin < 60) return `há ${diffMin}min`
  if (diffHoras < 24) return `há ${diffHoras}h`
  if (diffDias < 30) return `há ${diffDias}d`

  // Para períodos maiores, usa formatação relativa genérica
  return rtf.format(-diffDias, "day").replace("dias", "d")
}

// ============================================================================
// AVATAR DO PROJETO
// ============================================================================

/**
 * Tokens de cor para avatares de projeto.
 * Usa as cores principais do tema MUI.
 */
const AVATAR_COLOR_TOKENS = [
  "#1976d2", // primary.main (azul)
  "#9c27b0", // secondary.main (roxo)
  "#0288d1", // info.main (ciano)
  "#2e7d32", // success.main (verde)
  "#ed6c02", // warning.main (laranja)
  "#d32f2f", // error.main (vermelho)
  "#455a64", // cinza escuro
  "#00796b", // teal
]

/**
 * Gera um avatar determinístico para um projeto.
 *
 * - letra: primeira letra maiúscula do nome, ou '#' se ausente
 * - cor: hash do projetoId sobre os tokens de cor (determinístico)
 */
export function projetoAvatar(
  projetoId: number,
  projetoNome?: string | null
): ProjetoAvatar {
  const letra = projetoNome && projetoNome.trim()
    ? projetoNome.trim()[0]!.toUpperCase()
    : "#"

  const index = Math.abs(projetoId) % AVATAR_COLOR_TOKENS.length
  const cor = AVATAR_COLOR_TOKENS[index]!

  return { letra, cor }
}

// ============================================================================
// MÉTRICAS DO MAPA
// ============================================================================

/**
 * Status que indicam tarefa em andamento (IA trabalhando).
 */
const STATUS_EM_ANDAMENTO = new Set(["analyzing", "running", "motor_fix"])

/**
 * Status que indicam tarefa concluída hoje.
 */
const STATUS_CONCLUIDOS = new Set(["completed", "finalizada", "deployed", "deployada"])

/**
 * Status que indicam tarefa bloqueada.
 */
const STATUS_BLOQUEADAS = new Set(["blocked", "failed"])

/**
 * Estações do fluxo principal e lateral (para contagem por estação).
 */
const ESTACOES = {
  draft: ["draft"],
  planned: ["planned"],
  analyzing: ["analyzing"],
  ready: ["ready"],
  running: ["running"],
  completed: ["completed", "finalizada"],
  deployed: ["deployed", "deployada"],
  waiting: ["awaiting_clarification", "paused"],
  repair: ["motor_fix"],
  attention: ["blocked", "failed"],
  closed: ["cancelled", "aborted"],
} as const

/**
 * Verifica se uma data ISO é do dia atual.
 */
function isHoje(data?: string | null, agora: Date = new Date()): boolean {
  if (!data) return false
  const dataObj = new Date(data)
  if (isNaN(dataObj.getTime())) return false
  return (
    dataObj.getFullYear() === agora.getFullYear() &&
    dataObj.getMonth() === agora.getMonth() &&
    dataObj.getDate() === agora.getDate()
  )
}

/**
 * Formata duração em minutos como string legível.
 * Ex: 135 → "2h 15min"
 */
function formatDuracao(minutos: number): string {
  if (minutos < 1) return "<1min"
  const horas = Math.floor(minutos / 60)
  const mins = Math.floor(minutos % 60)
  if (horas === 0) return `${mins}min`
  if (mins === 0) return `${horas}h`
  return `${horas}h ${mins}min`
}

/**
 * Calcula métricas consolidadas para o Mapa Vivo da Operação.
 *
 * - total: total de tarefas
 * - emAndamento: tarefas em analyzing/running/motor_fix
 * - concluidasHoje: tarefas completed/finalizada/deployed/deployada com updatedAt no dia
 * - bloqueadas: tarefas blocked/failed
 * - tempoMedioExecucao: média de updatedAt-createdAt das concluídas (formato "2h 15min" ou "—")
 * - porEstacao: contagem por id de estação
 */
export function calcularMetricas(
  tarefas: TarefaParaMetricas[],
  agora: Date = new Date()
): MetricasMapa {
  const total = tarefas.length
  const emAndamento = tarefas.filter((t) => STATUS_EM_ANDAMENTO.has(t.status)).length
  const concluidasHoje = tarefas.filter(
    (t) => STATUS_CONCLUIDOS.has(t.status) && isHoje(t.updatedAt, agora)
  ).length
  const bloqueadas = tarefas.filter((t) => STATUS_BLOQUEADAS.has(t.status)).length

  // Tempo médio de execução (concluídas com createdAt e updatedAt válidos)
  const concluidasComTempo = tarefas.filter(
    (t) =>
      STATUS_CONCLUIDOS.has(t.status) &&
      t.createdAt &&
      t.updatedAt &&
      !isNaN(new Date(t.createdAt).getTime()) &&
      !isNaN(new Date(t.updatedAt).getTime())
  )

  let tempoMedioExecucao = "—"
  if (concluidasComTempo.length > 0) {
    const totalMinutos = concluidasComTempo.reduce((acc, t) => {
      const created = new Date(t.createdAt!).getTime()
      const updated = new Date(t.updatedAt!).getTime()
      const diffMin = (updated - created) / 60000
      return acc + Math.max(0, diffMin)
    }, 0)
    const mediaMin = totalMinutos / concluidasComTempo.length
    tempoMedioExecucao = formatDuracao(mediaMin)
  }

  // Contagem por estação
  const porEstacao: Record<string, number> = {}
  for (const [estacao, statuses] of Object.entries(ESTACOES)) {
    porEstacao[estacao] = tarefas.filter((t) => statuses.includes(t.status)).length
  }

  return {
    total,
    emAndamento,
    concluidasHoje,
    bloqueadas,
    tempoMedioExecucao,
    porEstacao,
  }
}

// ============================================================================
// VALIDAÇÃO DE COBERTURA
// ============================================================================

/**
 * Verifica se PRIORIDADE_POR_STATUS cobre todos os ALL_TASK_STATUSES.
 * Retorna array de status não cobertos (vazio se completo).
 */
export function validarCoberturaPrioridade(): string[] {
  return ALL_TASK_STATUSES.filter((status) => !(status in PRIORIDADE_POR_STATUS))
}
