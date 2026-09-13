/**
 * operationMapModel.ts — modelo puro do Mapa Vivo da Operação.
 *
 * Tarefa 826 — "Nova tela Mapa de Agentes" (menu "Mapa de agentes" abaixo de
 * "Acompanhar Tarefa"). Esta é a camada de **modelo** da tela nova: catálogo
 * de estações, classificação de tarefas, filtros, métricas, densidade de
 * marcadores, workers e intervenção humana.
 *
 * Regras deste módulo:
 * - Puro e determinístico: sem React, sem MUI, sem I/O, sem `Date.now()`
 *   implícito (o "agora" é sempre injetável). Só é importado por tipo das
 *   telas — nunca em tempo de execução.
 * - Uma só lógica, duas UIs: os tipos de tarefa/filtro/atividade são os
 *   mesmos de `TaskFlowMap` (tela legada) e os status/labels vêm da fonte
 *   canônica `motor-v2/src/shared/task-statuses.ts`. Nada é duplicado.
 * - O mapa não executa regra de negócio: apenas classifica e apresenta dados
 *   já governados pelo motor. As ações continuam delegadas à tela.
 *
 * Invariantes cobertos (ver docs/AUDITORIA-E-INVARIANTES-MAPA-DE-AGENTES.md):
 * INV-F1 (alcance), INV-F2 (densidade/acesso às demais), INV-F3 (filtros),
 * INV-F7 (deployadas sem lista ilimitada), INV-F8 (exceções), INV-F9 (espera
 * humana), INV-F10 (contadores coerentes), INV-F11 (`paused` sem subtarefas é
 * Rascunho), INV-C2 (sem duplicar status/labels) e INV-A2 (nunca só cor).
 *
 * Verificadores: `verificarInvariantesDoModelo()` + a suíte
 * `__tests__/operationMapModel.test.ts`.
 */

import {
  ALL_TASK_STATUSES,
  TASK_STATUS_EXECUTING,
  TASK_STATUS_FINAIS,
  taskStatusLabel,
} from "../motor-v2/src/shared/task-statuses"
import {
  calcularMetricas,
  deriveTaskPriority,
  type Prioridade,
} from "./taskFlowHelpers"
import type {
  FiltrosMapa,
  FlowTask,
  MotorActivity,
  ProjetoInfo,
} from "./TaskFlowMap"

// ============================================================================
// TIPOS BASE (aliases dos tipos já usados pela tela — sem duplicação)
// ============================================================================

/** Tarefa como o mapa a enxerga (mesmo shape da tela legada). */
export type OperationTask = FlowTask
/** Filtros do mapa (mesmo contrato da tela legada). */
export type OperationFilters = FiltrosMapa
/** Projeto para o seletor de filtro. */
export type OperationProject = ProjetoInfo
/** Atividade do motor (verificação/deploy) usada pelos indicadores vivos. */
export type OperationActivity = MotorActivity

/** Tom visual de uma estação. A cor é só reforço: sempre acompanha rótulo. */
export type OperationStationTone =
  | "neutral"
  | "active"
  | "success"
  | "warning"
  | "danger"

/** Separação conceitual pedida pela missão: fluxo principal x exceções. */
export type OperationStationFlow = "main" | "exception"

/** Chave de ícone (a tela resolve para o ícone concreto do design system). */
export type OperationStationIconKey =
  | "draft"
  | "planned"
  | "analyzing"
  | "ready"
  | "running"
  | "completed"
  | "deployed"
  | "waiting"
  | "repair"
  | "attention"
  | "closed"

export interface OperationStation {
  readonly id: string
  readonly label: string
  readonly subtitle: string
  readonly statuses: readonly string[]
  readonly tone: OperationStationTone
  readonly flow: OperationStationFlow
  readonly iconKey: OperationStationIconKey
}

// ============================================================================
// METADADOS DE TOM (INV-A2: nunca transmitir estado só por cor)
// ============================================================================

export interface OperationToneMeta {
  /** Rótulo textual do significado do tom. */
  readonly label: string
  /** Token do tema MUI (INV-A1: nada de cor hardcoded incompatível). */
  readonly colorToken: string
  /** Reforço simbólico opcional usado nos resumos. */
  readonly glyph: string
}

export const OPERATION_TONE_META: Readonly<
  Record<OperationStationTone, OperationToneMeta>
> = {
  neutral: { label: "Inativo", colorToken: "text.disabled", glyph: "○" },
  active: { label: "Ativo", colorToken: "primary.main", glyph: "◉" },
  success: { label: "Concluído", colorToken: "success.main", glyph: "●" },
  warning: { label: "Aguardando", colorToken: "warning.main", glyph: "◐" },
  danger: { label: "Atenção", colorToken: "error.main", glyph: "▲" },
}

/** Descreve um tom para leitores de tela (nunca depender só da cor). */
export function describeTone(tone: OperationStationTone): OperationToneMeta {
  return OPERATION_TONE_META[tone]
}

// ============================================================================
// CATÁLOGO DE ESTAÇÕES
// ============================================================================

/**
 * Mesmo agrupamento de status da tela legada (`MAIN_FLOW`/`SIDE_FLOW`) —
 * a equivalência é verificada em `__tests__/operationMapModel.test.ts`.
 */
export const OPERATION_MAIN_STATIONS: readonly OperationStation[] = [
  {
    id: "draft",
    label: "Rascunhos",
    subtitle: "não iniciadas ou pausadas sem subtarefas",
    statuses: ["draft"],
    tone: "neutral",
    flow: "main",
    iconKey: "draft",
  },
  {
    id: "planned",
    label: "Planejadas",
    subtitle: "aguardando análise",
    statuses: ["planned"],
    tone: "neutral",
    flow: "main",
    iconKey: "planned",
  },
  {
    id: "analyzing",
    label: "Em análise",
    subtitle: "IA analisando",
    statuses: ["analyzing"],
    tone: "active",
    flow: "main",
    iconKey: "analyzing",
  },
  {
    id: "ready",
    label: "Fila de Execução",
    subtitle: "próxima subtarefa",
    statuses: ["ready"],
    tone: "neutral",
    flow: "main",
    iconKey: "ready",
  },
  {
    id: "running",
    label: "Em execução",
    subtitle: "IA trabalhando",
    statuses: ["running"],
    tone: "active",
    flow: "main",
    iconKey: "running",
  },
  {
    id: "completed",
    label: "Concluídas",
    subtitle: "entregues",
    statuses: ["completed", "finalizada"],
    tone: "success",
    flow: "main",
    iconKey: "completed",
  },
  {
    id: "deployed",
    label: "Deployadas",
    subtitle: "em produção",
    statuses: ["deployed", "deployada"],
    tone: "success",
    flow: "main",
    iconKey: "deployed",
  },
] as const

/** Estados excepcionais — intervenção/espera. Nunca fazem parte do fluxo feliz. */
export const OPERATION_EXCEPTION_STATIONS: readonly OperationStation[] = [
  {
    id: "waiting",
    label: "Aguardando",
    subtitle: "pausa ou resposta humana",
    statuses: ["awaiting_clarification", "paused"],
    tone: "warning",
    flow: "exception",
    iconKey: "waiting",
  },
  {
    id: "repair",
    label: "Correção do motor",
    subtitle: "IA corrigindo o fluxo",
    statuses: ["motor_fix"],
    tone: "active",
    flow: "exception",
    iconKey: "repair",
  },
  {
    id: "attention",
    label: "Atenção",
    subtitle: "exige intervenção",
    statuses: ["blocked", "failed"],
    tone: "danger",
    flow: "exception",
    iconKey: "attention",
  },
  {
    id: "closed",
    label: "Encerradas",
    subtitle: "canceladas ou abortadas",
    statuses: ["cancelled", "aborted"],
    tone: "neutral",
    flow: "exception",
    iconKey: "closed",
  },
] as const

export const OPERATION_STATIONS: readonly OperationStation[] = [
  ...OPERATION_MAIN_STATIONS,
  ...OPERATION_EXCEPTION_STATIONS,
]

export const OPERATION_STATION_BY_ID: Readonly<
  Record<string, OperationStation>
> = Object.fromEntries(OPERATION_STATIONS.map((station) => [station.id, station]))

/** Estação usada quando o status não pertence a nenhuma estação (fallback seguro). */
export const OPERATION_FALLBACK_STATION_ID = "attention"

/** Status de tarefa que significam "IA trabalhando agora". */
export const OPERATION_ACTIVE_AI_STATUSES: ReadonlySet<string> = new Set([
  "analyzing",
  "running",
  "motor_fix",
])

/** Status que representam espera por resposta humana (INV-F9). */
export const OPERATION_HUMAN_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_clarification",
])

/**
 * Status efetivo de uma tarefa no mapa.
 *
 * Regra herdada das duas telas (INV-F11): `paused` **sem subtarefas**
 * (`subtaskCount === 0` ou ausente) é um Rascunho, não uma espera.
 */
export function effectiveOperationStatus(task: {
  status: string
  subtaskCount?: number
}): string {
  if (
    task.status === "paused" &&
    (task.subtaskCount === 0 || task.subtaskCount === undefined)
  ) {
    return "draft"
  }
  return task.status
}

/** Estação de um status. `undefined` quando o status não é conhecido. */
export function stationForStatus(status: string): OperationStation | undefined {
  return OPERATION_STATIONS.find((station) =>
    station.statuses.includes(status),
  )
}

/**
 * Estação de uma tarefa, aplicando o status efetivo (INV-F11).
 * Status desconhecido cai em "Atenção" para permanecer alcançável (INV-F1).
 */
export function stationForTask(task: {
  status: string
  subtaskCount?: number
}): OperationStation {
  const station = stationForStatus(effectiveOperationStatus(task))
  return (
    station ??
    OPERATION_STATION_BY_ID[OPERATION_FALLBACK_STATION_ID] ??
    OPERATION_EXCEPTION_STATIONS[OPERATION_EXCEPTION_STATIONS.length - 1]!
  )
}

/** Tarefas cujo status não pertence a nenhuma estação (verificador). */
export function unmappedTasks(
  tarefas: readonly OperationTask[],
): OperationTask[] {
  return tarefas.filter(
    (task) => stationForStatus(effectiveOperationStatus(task)) === undefined,
  )
}

/** Tarefas de uma estação (status efetivo aplicado). */
export function stationTasks(
  tarefas: readonly OperationTask[],
  station: OperationStation,
): OperationTask[] {
  return tarefas.filter((task) =>
    station.statuses.includes(effectiveOperationStatus(task)),
  )
}

// ============================================================================
// FILTROS (INV-F3)
// ============================================================================

export interface OperationFilterGroup {
  readonly id: string
  readonly label: string
  readonly statuses: readonly string[]
}

/**
 * Grupos de status para os chips de filtro. `aguardando` destaca só a
 * resposta humana (`awaiting_clarification`); a estação `waiting` continua
 * recebendo `paused` — comportamento aceito e registrado (R3 da auditoria).
 */
export const OPERATION_FILTER_GROUPS: readonly OperationFilterGroup[] = [
  {
    id: "em-execucao",
    label: "Em execução",
    statuses: ["running", "analyzing", "motor_fix"],
  },
  {
    id: "aguardando",
    label: "Aguardando você",
    statuses: ["awaiting_clarification"],
  },
  {
    id: "bloqueadas",
    label: "Bloqueadas",
    statuses: ["blocked", "failed"],
  },
  {
    id: "concluidas",
    label: "Concluídas",
    statuses: ["completed", "finalizada", "deployed", "deployada"],
  },
] as const

export const OPERATION_FILTER_GROUP_IDS: readonly string[] =
  OPERATION_FILTER_GROUPS.map((group) => group.id)

export const EMPTY_OPERATION_FILTERS: OperationFilters = {
  busca: "",
  status: [],
  projetoId: "",
  prioridade: "",
}

/** Converte slugs de filtro em status concretos (ignora slug desconhecido). */
export function resolveFilterGroupStatuses(
  slugs: readonly string[],
): string[] {
  return slugs.flatMap(
    (slug) =>
      OPERATION_FILTER_GROUPS.find((group) => group.id === slug)?.statuses ?? [],
  )
}

export function hasActiveOperationFilters(filtros: OperationFilters): boolean {
  return (
    filtros.busca.trim() !== "" ||
    filtros.status.length > 0 ||
    filtros.projetoId !== "" ||
    filtros.prioridade !== ""
  )
}

/**
 * Aplica os filtros do mapa. Mesma semântica da tela legada:
 * busca por `#id` + título, projeto por id, prioridade derivada do status e,
 * nos chips, o status **efetivo** (para `paused` sem subtarefas não contar
 * como espera — INV-F11).
 */
export function filterOperationTasks(
  tarefas: readonly OperationTask[],
  filtros: OperationFilters,
): OperationTask[] {
  const busca = filtros.busca.trim().toLocaleLowerCase("pt-BR")
  const statusesAtivos = resolveFilterGroupStatuses(filtros.status)
  return tarefas.filter((task) => {
    if (busca) {
      const alvo = `#${task.id} ${task.titulo}`.toLocaleLowerCase("pt-BR")
      if (!alvo.includes(busca)) return false
    }
    if (statusesAtivos.length > 0) {
      if (!statusesAtivos.includes(effectiveOperationStatus(task))) return false
    }
    if (filtros.projetoId !== "" && task.projetoId !== filtros.projetoId)
      return false
    if (
      filtros.prioridade !== "" &&
      deriveTaskPriority(task.status) !== filtros.prioridade
    ) {
      return false
    }
    return true
  })
}

export interface OperationFilterChip {
  /** Chave estável para remoção (ex.: "busca", "projeto", "status:em-execucao"). */
  readonly key: string
  readonly label: string
}

/**
 * Descreve os filtros ativos em texto (ex.: `Projeto: Biblioteca ×`), para a
 * tela deixar visível *por que* o mapa está reduzido (INV-F3).
 */
export function describeActiveOperationFilters(
  filtros: OperationFilters,
  projetos: readonly OperationProject[] = [],
): OperationFilterChip[] {
  const chips: OperationFilterChip[] = []
  const busca = filtros.busca.trim()
  if (busca) chips.push({ key: "busca", label: `Busca: ${busca}` })
  for (const slug of filtros.status) {
    const group = OPERATION_FILTER_GROUPS.find((item) => item.id === slug)
    chips.push({
      key: `status:${slug}`,
      label: `Status: ${group?.label ?? slug}`,
    })
  }
  if (filtros.projetoId !== "") {
    const nome =
      projetos.find((projeto) => projeto.id === filtros.projetoId)?.nome ??
      `#${filtros.projetoId}`
    chips.push({ key: "projeto", label: `Projeto: ${nome}` })
  }
  if (filtros.prioridade !== "") {
    chips.push({
      key: "prioridade",
      label: `Prioridade: ${filtros.prioridade}`,
    })
  }
  return chips
}

// ============================================================================
// DENSIDADE DE MARCADORES (INV-F2 e INV-F7)
// ============================================================================

/** Marcadores visíveis por estação antes de oferecer "ver todas". */
export const OPERATION_MARKER_LIMIT = 5

/** Prévia do terminal de produção (Deployadas) — nunca lista ilimitada. */
export const OPERATION_DEPLOYED_PREVIEW_LIMIT = 3

export interface OperationDensity<T> {
  /** Itens que devem ser desenhados. */
  readonly visible: readonly T[]
  /** Quantos ficaram ocultos atrás do "+N / ver todas". */
  readonly hidden: number
  /** Total sempre disponível — a contagem nunca se perde (INV-F2). */
  readonly total: number
  readonly hasMore: boolean
}

/**
 * Densidade de marcadores: mostra no máximo `limit` (5 por padrão) e informa
 * quantos ficaram ocultos. `expanded` revela todas — o acesso às demais
 * tarefas nunca é removido (INV-F2).
 */
export function selectVisibleMarkers<T>(
  items: readonly T[],
  options: { expanded?: boolean; limit?: number } = {},
): OperationDensity<T> {
  const limit = Math.max(1, options.limit ?? OPERATION_MARKER_LIMIT)
  const total = items.length
  if (options.expanded) {
    return { visible: items.slice(), hidden: 0, total, hasMore: false }
  }
  const visible = items.slice(0, limit)
  const hidden = Math.max(0, total - visible.length)
  return { visible, hidden, total, hasMore: hidden > 0 }
}

/** Ordena por atividade mais recente (`updatedAt`, com `createdAt` de reserva). */
export function sortByRecency(
  tarefas: readonly OperationTask[],
): OperationTask[] {
  const tempo = (task: OperationTask): number => {
    const valor = task.updatedAt ?? task.createdAt ?? null
    const ts = valor ? new Date(valor).getTime() : NaN
    return Number.isNaN(ts) ? 0 : ts
  }
  return tarefas
    .map((task, index) => ({ task, index, ts: tempo(task) }))
    .sort((a, b) => b.ts - a.ts || a.index - b.index)
    .map((item) => item.task)
}

// ============================================================================
// INTERVENÇÃO HUMANA (INV-F9)
// ============================================================================

/** Tarefas que esperam resposta nossa (status efetivo `awaiting_clarification`). */
export function tasksAwaitingHuman(
  tarefas: readonly OperationTask[],
): OperationTask[] {
  return tarefas.filter((task) =>
    OPERATION_HUMAN_STATUSES.has(effectiveOperationStatus(task)),
  )
}

// ============================================================================
// WORKERS (indicador compacto de operação viva)
// ============================================================================

export interface OperationWorker {
  readonly executionId?: string
  readonly taskId: string
  readonly subtaskId?: number | null
  readonly phase?: string | null
  readonly executionPhase?: string | null
  readonly projectSlug?: string | null
  readonly ageMs?: number | null
  readonly lastHeartbeatAt?: string | null
  /** Executando agora (qualquer worker ativo do motor). */
  readonly busy: boolean
}

export interface OperationWorkersSummary {
  readonly activeWorkers: number
  readonly maxWorkers: number | null
  readonly workers: readonly OperationWorker[]
  /** Ids de tarefa com worker ativo (usados para destacar o mapa). */
  readonly executingTaskIds: readonly string[]
  readonly busy: boolean
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Resumo defensivo do payload de `GET /gerenteagentes/motor-activity`
 * (= `GET /api/motor/stats`). Payload inesperado vira resumo vazio em vez de
 * quebrar o mapa (o contrato da API não é alterado).
 */
export function summarizeWorkers(stats: unknown): OperationWorkersSummary {
  const empty: OperationWorkersSummary = {
    activeWorkers: 0,
    maxWorkers: null,
    workers: [],
    executingTaskIds: [],
    busy: false,
  }
  if (!isRecord(stats)) return empty

  const rawWorkers = Array.isArray(stats.workers) ? stats.workers : []
  const workers: OperationWorker[] = []
  for (const raw of rawWorkers) {
    if (!isRecord(raw)) continue
    const taskId = toStringOrNull(raw.taskId)
    if (!taskId) continue
    workers.push({
      executionId: toStringOrNull(raw.executionId) ?? undefined,
      taskId,
      subtaskId: toNumberOrNull(raw.subtaskId),
      phase: toStringOrNull(raw.phase),
      executionPhase: toStringOrNull(raw.executionPhase),
      projectSlug: toStringOrNull(raw.projectSlug),
      ageMs: toNumberOrNull(raw.ageMs),
      lastHeartbeatAt: toStringOrNull(raw.lastHeartbeatAt),
      busy: true,
    })
  }

  const activeWorkers =
    toNumberOrNull(stats.activeWorkers) ?? workers.length
  const executingTaskIds = [...new Set(workers.map((worker) => worker.taskId))]
  return {
    activeWorkers,
    maxWorkers: toNumberOrNull(stats.maxWorkers),
    workers,
    executingTaskIds,
    busy: activeWorkers > 0 || workers.length > 0,
  }
}

// ============================================================================
// CONEXÃO EM TEMPO REAL (INV-F10)
// ============================================================================

export type OperationConnectionState = "connecting" | "open" | "closed"

export interface OperationConnectionDescriptor {
  readonly state: OperationConnectionState
  readonly label: string
  readonly tone: OperationStationTone
  readonly ariaLabel: string
}

export function describeConnection(
  state: OperationConnectionState,
): OperationConnectionDescriptor {
  switch (state) {
    case "open":
      return {
        state,
        label: "Tempo real conectado",
        tone: "success",
        ariaLabel: "Atualização em tempo real conectada",
      }
    case "connecting":
      return {
        state,
        label: "Conectando…",
        tone: "warning",
        ariaLabel: "Conectando à atualização em tempo real",
      }
    default:
      return {
        state,
        label: "Reconectando…",
        tone: "warning",
        ariaLabel: "Tempo real desconectado; tentando reconectar",
      }
  }
}

// ============================================================================
// MÉTRICAS DO TOPO (compactas — INV-A6)
// ============================================================================

export interface OperationMetrics {
  /** Total de tarefas conhecidas. */
  readonly total: number
  /** Total após os filtros. */
  readonly filtered: number
  /** IA trabalhando agora (analyzing/running/motor_fix). */
  readonly executing: number
  /** blocked/failed. */
  readonly blocked: number
  /** completed/deployed (+ legados). */
  readonly delivered: number
  /** deployadas (+ legado `deployada`). */
  readonly deployed: number
  /** Esperando resposta humana. */
  readonly awaitingHuman: number
  /** Concluídas hoje (métrica do helper legado). */
  readonly completedToday: number
  /** Tempo médio de execução formatado (helper legado). */
  readonly averageExecutionTime: string
  readonly workers: OperationWorkersSummary
  /** Contagem por estação (chaves = ids de estação). */
  readonly byStation: Readonly<Record<string, number>>
}

function countStatuses(
  tarefas: readonly OperationTask[],
  statuses: readonly string[],
): number {
  const alvo = new Set(statuses)
  return tarefas.filter((task) => alvo.has(task.status)).length
}

export function summarizeMetrics(
  tarefas: readonly OperationTask[],
  filtered: readonly OperationTask[],
  workers: OperationWorkersSummary,
  agora: Date = new Date(),
): OperationMetrics {
  const base = calcularMetricas(tarefas.slice(), agora)
  return {
    total: tarefas.length,
    filtered: filtered.length,
    executing: tarefas.filter((task) =>
      OPERATION_ACTIVE_AI_STATUSES.has(task.status),
    ).length,
    blocked: countStatuses(tarefas, ["blocked", "failed"]),
    delivered: countStatuses(tarefas, [
      "completed",
      "finalizada",
      "deployed",
      "deployada",
    ]),
    deployed: countStatuses(tarefas, ["deployed", "deployada"]),
    awaitingHuman: tasksAwaitingHuman(tarefas).length,
    completedToday: base.concluidasHoje,
    averageExecutionTime: base.tempoMedioExecucao,
    workers,
    byStation: base.porEstacao,
  }
}

// ============================================================================
// MODELO COMPLETO DO MAPA
// ============================================================================

export interface OperationStationView {
  readonly station: OperationStation
  /** Total na estação, ignorando filtros (o número da estação). */
  readonly total: number
  /** Total na estação após os filtros. */
  readonly filteredTotal: number
  readonly density: OperationDensity<OperationTask>
  /** Marcadores a desenhar (atalho para `density.visible`). */
  readonly markers: readonly OperationTask[]
  readonly hiddenCount: number
  readonly expanded: boolean
  readonly hasMore: boolean
  /** Há IA trabalhando nesta estação agora? */
  readonly active: boolean
}

export interface OperationExceptionsSummary {
  readonly total: number
  readonly byStation: Readonly<Record<string, number>>
  /** Alguma exceção com quantidade > 0? (INV-F8) */
  readonly hasAny: boolean
  /** Exceção que exige gente agora (atenção ou espera humana). */
  readonly needsHuman: number
}

export interface OperationMapInput {
  readonly tarefas: readonly OperationTask[]
  readonly projetos?: readonly OperationProject[]
  readonly atividades?: readonly OperationActivity[]
  readonly filtros?: OperationFilters
  /** Payload cru de `/motor-activity` (stats) para o resumo de workers. */
  readonly stats?: unknown
  readonly selectedTaskId?: number | ""
  /** Estações expandidas (botão "+N / ver todas"). */
  readonly expandedStations?: readonly string[]
  /** "Agora" injetável — mantém o modelo determinístico nos testes. */
  readonly agora?: Date
}

export interface OperationMapModel {
  readonly stations: readonly OperationStationView[]
  readonly mainStations: readonly OperationStationView[]
  readonly exceptionStations: readonly OperationStationView[]
  readonly filtered: readonly OperationTask[]
  readonly metrics: OperationMetrics
  readonly exceptions: OperationExceptionsSummary
  readonly awaitingHuman: readonly OperationTask[]
  /** Prévia do terminal de produção (Deployadas). */
  readonly deployedPreview: OperationDensity<OperationTask>
  readonly activities: readonly OperationActivity[]
  /** Ids de tarefa com worker ativo (destaque vivo no mapa). */
  readonly activeTaskIds: readonly string[]
  /** Tarefas com status fora do catálogo — reportadas, nunca escondidas. */
  readonly unmapped: readonly OperationTask[]
  readonly activeFilters: readonly OperationFilterChip[]
  readonly hasActiveFilters: boolean
}

function buildStationView(
  station: OperationStation,
  tarefas: readonly OperationTask[],
  filtered: readonly OperationTask[],
  expanded: boolean,
): OperationStationView {
  const all = stationTasks(tarefas, station)
  const visibleTasks = stationTasks(filtered, station)
  const density = selectVisibleMarkers(visibleTasks, { expanded })
  return {
    station,
    total: all.length,
    filteredTotal: visibleTasks.length,
    density,
    markers: density.visible,
    hiddenCount: density.hidden,
    expanded,
    hasMore: density.hasMore,
    active: station.tone === "active" && visibleTasks.length > 0,
  }
}

/**
 * Constrói o modelo completo do mapa a partir dos dados já carregados pela
 * tela. Função pura: não muta as entradas e é determinística para o mesmo
 * input (o `agora` é injetável).
 */
export function buildOperationMapModel(
  input: OperationMapInput,
): OperationMapModel {
  const tarefas = input.tarefas
  const projetos = input.projetos ?? []
  const filtros = input.filtros ?? EMPTY_OPERATION_FILTERS
  const expanded = new Set(input.expandedStations ?? [])
  const filtered = filterOperationTasks(tarefas, filtros)
  const workers = summarizeWorkers(input.stats)

  const stationViews = OPERATION_STATIONS.map((station) =>
    buildStationView(station, tarefas, filtered, expanded.has(station.id)),
  )
  const mainStations = stationViews.filter(
    (view) => view.station.flow === "main",
  )
  const exceptionStations = stationViews.filter(
    (view) => view.station.flow === "exception",
  )

  const exceptionsByStation: Record<string, number> = {}
  for (const view of exceptionStations) {
    exceptionsByStation[view.station.id] = view.filteredTotal
  }
  const exceptionsTotal = Object.values(exceptionsByStation).reduce(
    (acc, value) => acc + value,
    0,
  )
  const awaitingHuman = tasksAwaitingHuman(filtered)
  const attentionCount = exceptionsByStation["attention"] ?? 0

  const deployedStation = OPERATION_STATION_BY_ID["deployed"]
  const deployedTasks = deployedStation
    ? sortByRecency(stationTasks(filtered, deployedStation))
    : []
  const deployedPreview = selectVisibleMarkers(deployedTasks, {
    limit: OPERATION_DEPLOYED_PREVIEW_LIMIT,
  })

  return {
    stations: stationViews,
    mainStations,
    exceptionStations,
    filtered,
    metrics: summarizeMetrics(tarefas, filtered, workers, input.agora),
    exceptions: {
      total: exceptionsTotal,
      byStation: exceptionsByStation,
      hasAny: exceptionsTotal > 0,
      needsHuman: awaitingHuman.length + attentionCount,
    },
    awaitingHuman,
    deployedPreview,
    activities: (input.atividades ?? []).slice(),
    activeTaskIds: workers.executingTaskIds,
    unmapped: unmappedTasks(tarefas),
    activeFilters: describeActiveOperationFilters(filtros, projetos),
    hasActiveFilters: hasActiveOperationFilters(filtros),
  }
}

// ============================================================================
// VERIFICADORES (usados pela suíte e, opcionalmente, em desenvolvimento)
// ============================================================================

/**
 * Verifica as invariantes estruturais do modelo. Retorna a lista de violações
 * encontradas (vazia = modelo íntegro). É a checagem que a tela nova pode
 * rodar em desenvolvimento para garantir que nenhuma estação se perdeu.
 */
export function verificarInvariantesDoModelo(): string[] {
  const violacoes: string[] = []
  const ids = new Set<string>()

  for (const station of OPERATION_STATIONS) {
    if (!station.id) violacoes.push("estação sem id")
    if (ids.has(station.id))
      violacoes.push(`id de estação duplicado: ${station.id}`)
    ids.add(station.id)
    if (!station.label.trim())
      violacoes.push(`estação ${station.id} sem rótulo (INV-A2)`)
    if (!station.subtitle.trim())
      violacoes.push(`estação ${station.id} sem descrição curta`)
    if (station.statuses.length === 0)
      violacoes.push(`estação ${station.id} sem status`)
    if (!OPERATION_TONE_META[station.tone])
      violacoes.push(`estação ${station.id} com tom inválido`)
    for (const status of station.statuses) {
      if (!ALL_TASK_STATUSES.includes(status as (typeof ALL_TASK_STATUSES)[number])) {
        violacoes.push(`estação ${station.id} referencia status inexistente: ${status}`)
      }
    }
  }

  // Todo status canônico precisa estar em exatamente uma estação.
  for (const status of ALL_TASK_STATUSES) {
    const estacoes = OPERATION_STATIONS.filter((station) =>
      station.statuses.includes(status),
    )
    if (estacoes.length === 0)
      violacoes.push(`status sem estação no mapa: ${status} (INV-F1)`)
    if (estacoes.length > 1)
      violacoes.push(
        `status em mais de uma estação: ${status} → ${estacoes
          .map((station) => station.id)
          .join(", ")}`,
      )
  }

  for (const group of OPERATION_FILTER_GROUPS) {
    if (group.statuses.length === 0)
      violacoes.push(`grupo de filtro ${group.id} sem status`)
    for (const status of group.statuses) {
      if (!ALL_TASK_STATUSES.includes(status as (typeof ALL_TASK_STATUSES)[number])) {
        violacoes.push(
          `grupo de filtro ${group.id} referencia status inexistente: ${status}`,
        )
      }
    }
  }

  if (OPERATION_MARKER_LIMIT < 1)
    violacoes.push("limite de marcadores precisa ser >= 1")

  return violacoes
}

/** Rótulo legível de um status — reexportado para a tela não duplicar. */
export { taskStatusLabel, TASK_STATUS_EXECUTING, TASK_STATUS_FINAIS }
export type { Prioridade }
