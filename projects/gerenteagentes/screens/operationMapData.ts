/**
 * operationMapData.ts — camada de DADOS e INTERAÇÕES do Mapa de Agentes.
 *
 * Tarefa **826** ("Nova tela Mapa de Agentes") — subtarefa **1086**
 * ("Reproduzir dados e interações existentes").
 *
 * Esta é a única fonte de leitura/estado operacional da tela nova. Ela
 * reproduz, sem alterar contrato, os mecanismos já usados pela tela legada
 * `TaskMonitorScreen.tsx`:
 *
 * | Mecanismo                  | Tela legada                          | Aqui |
 * |----------------------------|--------------------------------------|------|
 * | Projetos                   | `GET /gerenteagentes/projetos_captados` (`pageSize: 100`) | `reloadProjects` |
 * | Tarefas + status do motor  | `GET /gerenteagentes/tarefas-com-status` (`pageSize: 100`, filtros opcionais) | `reloadTasks` |
 * | Detalhe do motor           | `GET /gerenteagentes/tarefas/:id/motor-detail` | `reloadDetail` |
 * | Subtarefas (banco)         | `GET /gerenteagentes/tarefas/:id/subtarefas` | `reloadDbSubtasks` |
 * | Chat (histórico)           | `GET /gerenteagentes/tarefas/:id/chat` | `reloadChat` |
 * | Atividade/workers + deploy | `GET /gerenteagentes/motor-activity` + `/motor-deploy-diagnostics` | `reloadActivity` |
 * | Polling de reconciliação   | `setInterval` 5 s (lista, atividade, selecionada) | `pollMs` |
 * | Tempo real                 | `RealtimeClient` (ticket + WS por tarefa) | `realtime` |
 * | Ações                      | `POST /tarefas/:id/{start,pause,resume,unlock}` | `execute` |
 * | Ações em massa             | `POST /tarefas/{pause-all,resume-all}` | `bulk` |
 *
 * Regras desta camada (invariantes da auditoria 1084):
 * - **INV-C1**: nenhum endpoint, payload ou regra de transição é criado/alterado.
 * - **INV-C3**: o hook não executa regra de negócio — só lê, classifica por
 *   evento e delega as ações ao motor.
 * - **INV-F5**: chat íntegro (merge idempotente por `id`, estados de espera/erro).
 * - **INV-F10**: tempo real + reconciliação (replay/polling) preservados e
 *   buffer de eventos com **limite** (padrão 500, igual à tela legada).
 * - **INV-F11**: o fallback de subtarefas (motor vazio → banco) é explícito
 *   em `resolveSubtasks` e testado.
 * - **INV-L1**: `TaskMonitorScreen.tsx`/`TaskFlowMap.tsx` não são tocados.
 *
 * O hook não conhece MUI nem layout: devolve estado + ações. A tela decide
 * como pintar (mapa, lista ou painel lateral).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RealtimeClient, type RealtimeServerMessage } from "@biblioteca-global/api-client"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveApiBaseUrl, resolveRealtimeUrl } from "../../../apps/web/src/api/client"
import {
  TASK_STATUS_EXECUTING,
  TASK_STATUS_FINAIS,
  TASK_STATUS_STARTABLE,
} from "../motor-v2/src/shared/task-statuses"
import type {
  FlowTask,
  MotorActivity,
  ProjetoInfo,
  RecoveryEligibility,
} from "./TaskFlowMap"

// ============================================================================
// CONSTANTES COMPARTILHADAS
// ============================================================================

/** Intervalo de reconciliação da tela legada (5 s). */
export const OPERATION_POLL_MS = 5000
/** Limite do buffer de eventos de tempo real da tela legada (`slice(-500)`). */
export const OPERATION_EVENT_LIMIT = 500
/** Papéis que representam "o agente" no chat. */
export const AGENT_CHAT_ROLES = ["assistant", "agent", "analyst"] as const

// ============================================================================
// TIPOS (mesmos contratos consumidos pela tela legada — nada novo)
// ============================================================================

/** Tarefa como o mapa a enxerga (mesmo shape retornado por `tarefas-com-status`). */
export interface OperationMapTask {
  id: number
  titulo: string
  descricao?: string | null
  tipo?: string | null
  status: string
  projetoId: number
  dependsOnTaskId?: number | null
  createdAt?: string
  updatedAt?: string
  subtaskCount?: number
  recoveryEligibility?: RecoveryEligibility | null
}

/** Tarefa já enriquecida com o nome do projeto (o que o canvas consome). */
export type OperationMapFlowTask = FlowTask

/** Projeto do seletor/filtro. */
export type OperationMapProject = ProjetoInfo

export interface OperationMapChatMessage {
  id: number
  tarefaId?: number
  role: string
  texto: string
  createdAt: string
}

/** Subtarefa persistida no banco (endpoint `/subtarefas`). */
export interface OperationMapDbSubtask {
  id: number
  seq: number
  titulo: string
  descricao?: string | null
  scope?: string | null
  acceptanceCriteria?: unknown
  status: string
  resultado?: string | null
  dependsOnSubtaskId?: number | null
  workspaceStatus?: string | null
  correctionForSubtaskId?: number | null
}

/** Subtarefa como o motor reporta no `motor-detail`. */
export interface OperationMapMotorSubtask {
  seq: number
  title: string
  status: string
  deliverCount?: number
  blockInfo?: { reason?: string; command?: string; exitCode?: number | null } | null
  scope?: string | null
  acceptanceCriteria?: unknown
  dependsOnSubtaskId?: number | null
  workspaceStatus?: string | null
  correctionForSubtaskId?: number | null
  deliveryHistory?: Array<{
    id: number
    deliverNumber: number
    model: string | null
    eventType: string
    reason: string | null
    createdAt: string
  }>
}

/** Payload de `motor-detail`. */
export interface OperationMapDetail {
  motorId?: string
  exists: boolean
  message?: string
  task?: {
    status: string
    title: string
    errorMessage?: string
    blockInfo?: {
      kind?: string
      excerpt?: string
      blockedAt?: string
      subtaskId?: number | null
    } | null
    recoveryEligibility?: RecoveryEligibility | null
  }
  subtasks?: OperationMapMotorSubtask[]
  currentSubTask?: OperationMapMotorSubtask | null
  events?: Array<{ at: string; type: string; payload?: Record<string, unknown> }>
}

/** Diagnóstico de deploy (`motor-deploy-diagnostics`). */
export interface OperationMapDeployDiagnostics {
  canStart: boolean
  reasons: string[]
  pendingRequests: number
}

/** Estatísticas do motor (mesmo payload de `motor-activity`). */
export interface OperationMapMotorStats {
  activities?: MotorActivity[]
  activeWorkers?: number
  maxWorkers?: number
  workers?: Array<{ executionId?: string; taskId?: string; subtaskId?: number; phase?: string; startedAt?: string }>
  deployments?: unknown[]
  [key: string]: unknown
}

export type OperationMapAction = "start" | "pause" | "resume" | "unlock"
export type OperationMapBulkAction = "pause-all" | "resume-all"
export type OperationMapRealtimeStatus = "connecting" | "open" | "closed"

export interface OperationMapDataOptions {
  /** Filtro server-side por projeto (paridade com a tela legada). */
  projetoId?: number | ""
  /** Filtro server-side por status (paridade com a tela legada). */
  status?: string
  /** Intervalo do polling em ms (`0` desliga). Padrão: 5000. */
  pollMs?: number
  /** Liga/desliga o `RealtimeClient` da tarefa selecionada. Padrão: `true`. */
  realtime?: boolean
  /** Limite do buffer de eventos de tempo real. Padrão: 500. */
  eventLimit?: number
}

export interface OperationMapData {
  /** `true` quando o bundle autenticado (`useApi`) está disponível. */
  ready: boolean
  /** `true` até a primeira carga de tarefas terminar. */
  loading: boolean
  /** Erro de leitura/ação (o chat tem canal próprio: `chatError`). */
  error: string | null
  clearError(): void

  tasks: OperationMapTask[]
  /** Tarefas + `projetoNome` — entrada direta do canvas/lista. */
  mappedTasks: OperationMapFlowTask[]
  projects: OperationMapProject[]
  activities: MotorActivity[]
  stats: OperationMapMotorStats | null
  diagnostics: OperationMapDeployDiagnostics | null

  selectedId: number | ""
  selected: OperationMapTask | undefined
  select(id: number | ""): void

  detail: OperationMapDetail | null
  dbSubtasks: OperationMapDbSubtask[]
  /** Subtarefas exibidas: motor quando disponível, senão banco (fallback). */
  subtasks: OperationMapMotorSubtask[]
  /** Fonte efetiva das subtarefas exibidas. */
  subtaskSource: "motor" | "db" | "none"

  status: string
  canStart: boolean
  canPause: boolean

  chat: OperationMapChatMessage[]
  chatInput: string
  setChatInput(value: string): void
  chatLoading: boolean
  chatSending: boolean
  chatWaiting: boolean
  chatError: string | null
  sendChat(): Promise<void>

  realtimeStatus: OperationMapRealtimeStatus
  realtimeEvents: RealtimeServerMessage[]
  eventLimit: number

  action: OperationMapAction | null
  execute(action: OperationMapAction, id?: number): Promise<void>
  bulkAction: OperationMapBulkAction | null
  bulkMessage: string | null
  clearBulkMessage(): void
  bulk(action: OperationMapBulkAction): Promise<void>
  /** Há tarefa não final e não pausada para "Pausar todas". */
  canPauseAll: boolean
  /** Há tarefa pausada para "Retomar todas". */
  canResumeAll: boolean

  reloadTasks(): Promise<void>
  reloadProjects(): Promise<void>
  reloadActivity(): Promise<void>
  reloadDetail(id?: number): Promise<void>
  reloadDbSubtasks(id?: number): Promise<void>
  reloadChat(id?: number): Promise<void>
  /** Recarrega detalhe + subtarefas + chat da tarefa selecionada. */
  refreshSelected(id?: number): Promise<void>
}

// ============================================================================
// FUNÇÕES PURAS (testáveis sem React — INV-F5/INV-F10/INV-F11)
// ============================================================================

/**
 * Mescla o histórico do servidor com o que já está em memória sem perder
 * mensagem recebida por WebSocket durante o GET (idempotente por `id`).
 */
export function mergeChatMessages(
  historico: OperationMapChatMessage[],
  atuais: OperationMapChatMessage[],
): OperationMapChatMessage[] {
  const porId = new Map(historico.map((mensagem) => [mensagem.id, mensagem]))
  for (const mensagem of atuais) {
    if (!porId.has(mensagem.id)) porId.set(mensagem.id, mensagem)
  }
  return [...porId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
}

/** Aplica o limite do buffer de eventos de tempo real (mais recentes ao final). */
export function limitRealtimeEvents(
  events: RealtimeServerMessage[],
  limit: number = OPERATION_EVENT_LIMIT,
): RealtimeServerMessage[] {
  if (limit <= 0) return []
  return events.length > limit ? events.slice(-limit) : events
}

/** Ordena tarefas por `updatedAt` (fallback `createdAt`) decrescente. */
export function sortTasksByRecency<T extends { createdAt?: string; updatedAt?: string }>(
  tasks: T[],
): T[] {
  return [...tasks].sort(
    (a, b) =>
      new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
      new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
  )
}

/**
 * Seleção inicial estável: mantém a seleção atual quando ela continua existindo,
 * senão prioriza a primeira tarefa não final e não rascunho (igual à legada).
 */
export function resolveSelection(
  tasks: OperationMapTask[],
  atual: number | "",
): number | "" {
  if (atual !== "" && tasks.some((tarefa) => tarefa.id === atual)) return atual
  const emAndamento = tasks.find(
    (tarefa) => !TASK_STATUS_FINAIS.has(tarefa.status) && tarefa.status !== "draft",
  )
  return emAndamento?.id ?? tasks[0]?.id ?? ""
}

/**
 * Aplica um evento de tarefa (`task.created|updated|status.changed|deleted`)
 * à lista em memória — mesmo comportamento de `aplicarEventoTarefa` da legada.
 * Devolve a mesma referência quando nada mudou.
 */
export function applyTaskEvent(
  tasks: OperationMapTask[],
  type: string,
  payload: Record<string, unknown>,
  eventTaskId: number,
): OperationMapTask[] {
  if (type === "task.deleted") {
    return tasks.filter((tarefa) => tarefa.id !== eventTaskId)
  }
  if (type === "task.status.changed") {
    const status = typeof payload.status === "string" ? payload.status : null
    if (!status) return tasks
    return tasks.map((tarefa) => (tarefa.id === eventTaskId ? { ...tarefa, status } : tarefa))
  }
  if (type !== "task.created" && type !== "task.updated") return tasks

  const evento: OperationMapTask = {
    id: Number(payload.id ?? eventTaskId),
    titulo: String(payload.titulo ?? payload.title ?? ""),
    descricao: typeof payload.descricao === "string" ? payload.descricao : null,
    tipo: typeof payload.tipo === "string" ? payload.tipo : null,
    dependsOnTaskId:
      typeof payload.dependsOnTaskId === "number" ? payload.dependsOnTaskId : null,
    status: String(payload.status ?? "draft"),
    projetoId: Number(payload.projetoId ?? payload.projectId ?? 0),
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
  }
  const indice = tasks.findIndex((tarefa) => tarefa.id === evento.id)
  if (indice < 0) return sortTasksByRecency([evento, ...tasks])
  const anterior = tasks[indice]
  if (!anterior) return tasks
  const proxima = [...tasks]
  proxima[indice] = {
    ...anterior,
    ...evento,
    ...(payload.descricao === undefined ? { descricao: anterior.descricao } : {}),
    ...(payload.tipo === undefined ? { tipo: anterior.tipo } : {}),
    ...(payload.dependsOnTaskId === undefined
      ? { dependsOnTaskId: anterior.dependsOnTaskId }
      : {}),
    ...(payload.createdAt === undefined ? { createdAt: anterior.createdAt } : {}),
  }
  return sortTasksByRecency(proxima)
}

/**
 * Fallback de subtarefas (INV-F11): usa as subtarefas do motor quando existem;
 * caso contrário converte as do banco (com os campos que faltam preenchidos).
 */
export function resolveSubtasks(
  detail: OperationMapDetail | null,
  dbSubtasks: OperationMapDbSubtask[],
): { subtasks: OperationMapMotorSubtask[]; source: "motor" | "db" | "none" } {
  if (detail?.subtasks?.length) {
    return { subtasks: detail.subtasks, source: "motor" }
  }
  if (dbSubtasks.length) {
    return {
      subtasks: dbSubtasks.map((sub) => ({
        seq: sub.seq,
        title: sub.titulo,
        status: sub.status,
        scope: sub.scope,
        acceptanceCriteria: sub.acceptanceCriteria,
        dependsOnSubtaskId: sub.dependsOnSubtaskId,
        workspaceStatus: sub.workspaceStatus,
        correctionForSubtaskId: sub.correctionForSubtaskId,
        deliverCount: 0,
        blockInfo: null,
        deliveryHistory: [],
      })),
      source: "db",
    }
  }
  return { subtasks: [], source: "none" }
}

/** Habilita "Iniciar" (start) — mesma regra da legada (`paused` ou startável). */
export function canStartTask(status: string): boolean {
  return status === "paused" || TASK_STATUS_STARTABLE.has(status)
}

/** Habilita "Pausar" — mesma regra da legada (`TASK_STATUS_EXECUTING`). */
export function canPauseTask(status: string): boolean {
  return TASK_STATUS_EXECUTING.has(status)
}

// ============================================================================
// HOOK
// ============================================================================

/**
 * Estado e ações operacionais da tela nova. Um único núcleo de lógica para
 * quantas representações a tela quiser oferecer (mapa, lista, atividade).
 */
export function useOperationMapData(
  options: OperationMapDataOptions = {},
): OperationMapData {
  const {
    projetoId = "",
    status: statusFiltro = "",
    pollMs = OPERATION_POLL_MS,
    realtime: realtimeHabilitado = true,
    eventLimit = OPERATION_EVENT_LIMIT,
  } = options

  const bundle = useApi()

  const [tasks, setTasks] = useState<OperationMapTask[]>([])
  const [projects, setProjects] = useState<OperationMapProject[]>([])
  const [activities, setActivities] = useState<MotorActivity[]>([])
  const [stats, setStats] = useState<OperationMapMotorStats | null>(null)
  const [diagnostics, setDiagnostics] = useState<OperationMapDeployDiagnostics | null>(null)

  const [selectedId, setSelectedId] = useState<number | "">("")
  const [detail, setDetail] = useState<OperationMapDetail | null>(null)
  const [dbSubtasks, setDbSubtasks] = useState<OperationMapDbSubtask[]>([])

  const [chat, setChat] = useState<OperationMapChatMessage[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [chatSending, setChatSending] = useState(false)
  const [chatWaiting, setChatWaiting] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<OperationMapAction | null>(null)
  const [bulkAction, setBulkAction] = useState<OperationMapBulkAction | null>(null)
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)

  const [realtimeStatus, setRealtimeStatus] = useState<OperationMapRealtimeStatus>("closed")
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeServerMessage[]>([])

  const mounted = useRef(true)
  const chatRequestId = useRef(0)
  const selectedIdRef = useRef<number | "">("")
  const activeRealtimeTask = useRef<number | "">("")

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // ------------------------------------------------------------------ leituras

  const reloadProjects = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<{ items: OperationMapProject[] }>(
        "GET",
        "/gerenteagentes/projetos_captados",
        { query: { pageSize: 100 }, auth: "access" },
      )
      if (mounted.current) setProjects(res.items ?? [])
    } catch {
      // silencioso — o seletor fica vazio até a próxima tentativa (igual à legada)
      if (mounted.current) setProjects([])
    }
  }, [bundle])

  const reloadTasks = useCallback(async () => {
    if (!bundle) return
    try {
      const query: Record<string, string | number> = { pageSize: 100 }
      if (projetoId !== "") query.projetoId = projetoId
      if (statusFiltro !== "") query.status = statusFiltro
      const res = await bundle.http.request<OperationMapTask[]>(
        "GET",
        "/gerenteagentes/tarefas-com-status",
        { query, auth: "access" },
      )
      if (!mounted.current) return
      const lista = sortTasksByRecency(res ?? [])
      setTasks(lista)
      setSelectedId((atual) => resolveSelection(lista, atual))
    } catch {
      // silencioso — preserva o mapa durante reinícios da API
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [bundle, projetoId, statusFiltro])

  const reloadActivity = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<OperationMapMotorStats>(
        "GET",
        "/gerenteagentes/motor-activity",
        { auth: "access" },
      )
      const deploy = await bundle.http.request<OperationMapDeployDiagnostics>(
        "GET",
        "/gerenteagentes/motor-deploy-diagnostics",
        { auth: "access" },
      )
      if (!mounted.current) return
      setActivities(res.activities ?? [])
      setStats(res)
      if (Array.isArray(deploy.reasons) && typeof deploy.pendingRequests === "number") {
        setDiagnostics(deploy)
      }
    } catch {
      // atividade é complementar; não interrompe o acompanhamento se o motor reiniciar
      if (mounted.current) setActivities([])
    }
  }, [bundle])

  const reloadDetail = useCallback(async (id?: number) => {
    const alvo = id ?? selectedIdRef.current
    if (!bundle || alvo === "") return
    try {
      const res = await bundle.http.request<OperationMapDetail>(
        "GET",
        `/gerenteagentes/tarefas/${alvo}/motor-detail`,
        { auth: "access" },
      )
      if (mounted.current && selectedIdRef.current === alvo) setDetail(res)
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : "Erro ao carregar detalhes da tarefa")
      }
    }
  }, [bundle])

  const reloadDbSubtasks = useCallback(async (id?: number) => {
    const alvo = id ?? selectedIdRef.current
    if (!bundle || alvo === "") return
    try {
      const res = await bundle.http.request<OperationMapDbSubtask[]>(
        "GET",
        `/gerenteagentes/tarefas/${alvo}/subtarefas`,
        { auth: "access" },
      )
      if (mounted.current && selectedIdRef.current === alvo) {
        setDbSubtasks(Array.isArray(res) ? res : [])
      }
    } catch {
      if (mounted.current && selectedIdRef.current === alvo) setDbSubtasks([])
    }
  }, [bundle])

  const reloadChat = useCallback(async (id?: number) => {
    const alvo = id ?? selectedIdRef.current
    if (!bundle || alvo === "") return
    const requestId = ++chatRequestId.current
    if (mounted.current) {
      setChatError(null)
      setChatLoading(true)
    }
    try {
      const res = await bundle.http.request<
        OperationMapChatMessage[] | { items?: OperationMapChatMessage[] }
      >("GET", `/gerenteagentes/tarefas/${alvo}/chat`, { auth: "access" })
      if (!mounted.current || requestId !== chatRequestId.current) return
      const historico = Array.isArray(res) ? res : res.items ?? []
      setChat((atual) => mergeChatMessages(historico, atual))
      const ultima = historico.at(-1)
      if (ultima && (AGENT_CHAT_ROLES as readonly string[]).includes(ultima.role)) {
        setChatWaiting(false)
      }
    } catch (e) {
      if (mounted.current && requestId === chatRequestId.current) {
        setChat([])
        setChatError(e instanceof Error ? e.message : "Não foi possível carregar o histórico do chat.")
      }
    } finally {
      if (mounted.current && requestId === chatRequestId.current) setChatLoading(false)
    }
  }, [bundle])

  const refreshSelected = useCallback(async (id?: number) => {
    const alvo = id ?? selectedIdRef.current
    if (alvo === "") return
    await Promise.all([reloadDetail(alvo), reloadDbSubtasks(alvo), reloadChat(alvo)])
  }, [reloadDetail, reloadDbSubtasks, reloadChat])

  // ------------------------------------------------------------------ polling

  useEffect(() => {
    void reloadTasks()
    void reloadProjects()
    void reloadActivity()
    if (!pollMs || pollMs <= 0) return
    const intervalId = window.setInterval(() => {
      void reloadTasks()
      void reloadActivity()
      const alvo = selectedIdRef.current
      if (alvo !== "") {
        void reloadDetail(alvo)
        void reloadDbSubtasks(alvo)
        void reloadChat(alvo)
      }
    }, pollMs)
    return () => window.clearInterval(intervalId)
  }, [reloadTasks, reloadProjects, reloadActivity, reloadDetail, reloadDbSubtasks, reloadChat, pollMs])

  // ------------------------------------------------------------------ seleção

  useEffect(() => {
    if (selectedId === "") {
      activeRealtimeTask.current = ""
      setRealtimeStatus("closed")
      setDetail(null)
      setDbSubtasks([])
      setChat([])
      setChatInput("")
      setChatError(null)
      setChatLoading(false)
      setChatWaiting(false)
      return
    }
    setDetail(null)
    setDbSubtasks([])
    setChat([])
    setChatInput("")
    setChatError(null)
    setChatLoading(true)
    setChatWaiting(false)
    void reloadDetail(selectedId)
    void reloadDbSubtasks(selectedId)
    void reloadChat(selectedId)
  }, [selectedId, reloadDetail, reloadDbSubtasks, reloadChat])

  // ------------------------------------------------------------------ tempo real

  const aplicarEvento = useCallback(
    (type: string, payload: Record<string, unknown>, eventTaskId: number) => {
      setTasks((atual) => applyTaskEvent(atual, type, payload, eventTaskId))
      if (type === "task.deleted") {
        setSelectedId((atual) => (atual === eventTaskId ? "" : atual))
      }
      if (eventTaskId === selectedIdRef.current) {
        setDetail((atual) =>
          atual?.task
            ? {
                ...atual,
                task: {
                  ...atual.task,
                  status: typeof payload.status === "string" ? payload.status : atual.task.status,
                  title: typeof payload.titulo === "string" ? payload.titulo : atual.task.title,
                },
              }
            : atual,
        )
      }
    },
    [],
  )

  useEffect(() => {
    if (!realtimeHabilitado || !bundle || selectedId === "") return
    activeRealtimeTask.current = selectedId
    setRealtimeEvents([])
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(),
      baseUrl: resolveApiBaseUrl(),
      taskId: selectedId,
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: (status) => {
        if (activeRealtimeTask.current === selectedId) setRealtimeStatus(status)
      },
      onMessage: (message) => {
        // O socket anterior pode entregar evento enfileirado depois da troca
        // de tarefa: nunca deixe contaminar a seleção nova.
        if (activeRealtimeTask.current !== selectedId) return
        if (message.type === "replay_unavailable") {
          // Buffer do servidor expirou: recupera a fonte persistida.
          void refreshSelected(selectedId)
          return
        }
        if (message.type === "error") {
          setChatError(message.message)
          return
        }
        if (message.type !== "event") return
        setRealtimeEvents((atual) => limitRealtimeEvents([...atual, message], eventLimit))
        const { type, payload, taskId: eventTaskId } = message.event
        if (type.includes("chat")) {
          const id = Number(payload.id)
          const texto = typeof payload.texto === "string" ? payload.texto : null
          const role = typeof payload.role === "string" ? payload.role : null
          if (id > 0 && texto && role) {
            setChat((atual) => {
              if (atual.some((item) => item.id === id)) return atual
              return [...atual, {
                id,
                tarefaId: selectedId,
                role,
                texto,
                createdAt:
                  typeof payload.createdAt === "string" ? payload.createdAt : message.event.occurredAt,
              }].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            })
            if ((AGENT_CHAT_ROLES as readonly string[]).includes(role)) setChatWaiting(false)
          } else {
            void reloadChat(selectedId)
          }
        }
        if (type === "task.status.changed" || type === "task.created" || type === "task.updated" || type === "task.deleted") {
          aplicarEvento(type, payload, eventTaskId)
        }
        if (type.startsWith("subtask.")) {
          // O protocolo de subtarefa não carrega todos os campos do detalhe:
          // reconcilia o snapshot após o evento, sem polling extra.
          void reloadDetail(selectedId)
          void reloadDbSubtasks(selectedId)
        }
      },
    })
    void client.connect()
    return () => {
      if (activeRealtimeTask.current === selectedId) activeRealtimeTask.current = ""
      client.close()
    }
  }, [realtimeHabilitado, selectedId, bundle, eventLimit, refreshSelected, reloadChat, reloadDetail, reloadDbSubtasks, aplicarEvento])

  // ------------------------------------------------------------------ ações

  const execute = useCallback(
    async (acao: OperationMapAction, id?: number) => {
      const alvo = id ?? selectedIdRef.current
      if (!bundle || alvo === "") return
      setAction(acao)
      setError(null)
      try {
        await bundle.http.request("POST", `/gerenteagentes/tarefas/${alvo}/${acao}`, {
          auth: "access",
        })
        await Promise.all([
          reloadDetail(alvo),
          reloadDbSubtasks(alvo),
          reloadTasks(),
        ])
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : `Erro ao ${acao === "unlock" ? "desbloquear" : acao === "pause" ? "pausar" : acao === "resume" ? "retomar" : "iniciar"} tarefa`,
        )
      } finally {
        if (mounted.current) setAction(null)
      }
    },
    [bundle, reloadDetail, reloadDbSubtasks, reloadTasks],
  )

  const bulk = useCallback(
    async (acao: OperationMapBulkAction) => {
      if (!bundle) return
      setBulkAction(acao)
      setBulkMessage(null)
      try {
        const res = await bundle.http.request<{ affected?: number }>(
          "POST",
          `/gerenteagentes/tarefas/${acao}`,
          { auth: "access" },
        )
        const contagem = typeof res?.affected === "number" ? res.affected : undefined
        const rotulo = acao === "pause-all" ? "pausada(s)" : "retomada(s)"
        setBulkMessage(
          contagem !== undefined
            ? `${contagem} tarefa${contagem === 1 ? "" : "s"} ${rotulo}.`
            : `Ação em massa executada.`,
        )
        await reloadTasks()
      } catch (e) {
        setBulkMessage(e instanceof Error ? e.message : "Não foi possível executar a ação.")
      } finally {
        if (mounted.current) setBulkAction(null)
      }
    },
    [bundle, reloadTasks],
  )

  const sendChat = useCallback(async () => {
    const texto = chatInput.trim()
    const alvo = selectedIdRef.current
    if (!bundle || alvo === "" || !texto || chatSending) return
    setChatSending(true)
    setChatWaiting(true)
    setChatError(null)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${alvo}/chat`, {
        body: { role: "user", texto },
        auth: "access",
      })
      // Só limpa o campo se a tarefa ainda for a mesma.
      if (selectedIdRef.current === alvo) {
        setChatInput("")
        // A resposta chega por WebSocket; a recarga é o fallback das APIs antigas.
        await reloadChat(alvo)
      }
    } catch (e) {
      if (selectedIdRef.current === alvo) {
        setChatWaiting(false)
        setChatError(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.")
      }
    } finally {
      if (mounted.current) setChatSending(false)
    }
  }, [bundle, chatInput, chatSending, reloadChat])

  // ------------------------------------------------------------------ derivados

  const mappedTasks = useMemo<OperationMapFlowTask[]>(
    () =>
      tasks.map((tarefa) => ({
        ...tarefa,
        createdAt: tarefa.createdAt ?? null,
        updatedAt: tarefa.updatedAt ?? null,
        projetoNome: projects.find((projeto) => projeto.id === tarefa.projetoId)?.nome ?? null,
      })),
    [tasks, projects],
  )

  const { subtasks, source: subtaskSource } = useMemo(
    () => resolveSubtasks(detail, dbSubtasks),
    [detail, dbSubtasks],
  )

  const selected = useMemo(
    () => tasks.find((tarefa) => tarefa.id === selectedId),
    [tasks, selectedId],
  )

  const status = detail?.task?.status ?? selected?.status ?? ""

  const canPauseAll = useMemo(
    () => tasks.some((tarefa) => !TASK_STATUS_FINAIS.has(tarefa.status) && tarefa.status !== "paused"),
    [tasks],
  )
  const canResumeAll = useMemo(
    () => tasks.some((tarefa) => tarefa.status === "paused"),
    [tasks],
  )

  const select = useCallback((id: number | "") => {
    setSelectedId(id)
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const clearBulkMessage = useCallback(() => setBulkMessage(null), [])

  return {
    ready: Boolean(bundle),
    loading,
    error,
    clearError,
    tasks,
    mappedTasks,
    projects,
    activities,
    stats,
    diagnostics,
    selectedId,
    selected,
    select,
    detail,
    dbSubtasks,
    subtasks,
    subtaskSource,
    status,
    canStart: canStartTask(status),
    canPause: canPauseTask(status),
    chat,
    chatInput,
    setChatInput,
    chatLoading,
    chatSending,
    chatWaiting,
    chatError,
    sendChat,
    realtimeStatus,
    realtimeEvents,
    eventLimit,
    action,
    execute,
    bulkAction,
    bulkMessage,
    clearBulkMessage,
    bulk,
    canPauseAll,
    canResumeAll,
    reloadTasks,
    reloadProjects,
    reloadActivity,
    reloadDetail,
    reloadDbSubtasks,
    reloadChat,
    refreshSelected,
  }
}
