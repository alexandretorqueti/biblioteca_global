/**
 * Mapa de agentes — visualização alternativa do acompanhamento operacional.
 *
 * Esta tela compartilha os endpoints e o modelo de status com o acompanhamento
 * legado. O mapa é apenas outra representação: nenhuma ação de negócio mora
 * em TaskFlowMap.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle,
  Divider, Drawer, IconButton, Paper, Stack, Tab, Tabs, TextField, Tooltip, Typography,
  useMediaQuery,
} from "@mui/material"
import { useTheme } from "@mui/material/styles"
import {
  AddTaskRounded, CloseRounded, CodeRounded, DeleteRounded, EditRounded, ExpandMoreRounded, ExpandLessRounded,
  LockOpenRounded, PauseRounded, PlayArrowRounded, PsychologyRounded, ReplayRounded,
  SendRounded, VisibilityRounded,
} from "@mui/icons-material"
import { DynamicForm } from "@biblioteca-global/ui"
import type { DynamicField, DynamicFormValues } from "@biblioteca-global/ui"
import { RealtimeClient } from "@biblioteca-global/api-client"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveApiBaseUrl, resolveRealtimeUrl } from "../../../apps/web/src/api/client"
import TarefaForm, { type TarefaFormValues } from "./TarefaForm"
import OperationMapCanvas from "./OperationMapCanvas"
import { recoveryEligibilityLabel, RecoveryEligibilityTooltipContent, type FiltrosMapa, type FlowTask, type MotorActivity, type RecoveryEligibility } from "./TaskFlowMap"
import AgentStatusStrip, { type AgentStatusStripProps } from "./AgentStatusStrip"
import { SUBTASK_STATUS_OPTIONS, TASK_STATUS_EXECUTING, TASK_STATUS_FINAIS, TASK_STATUS_PAUSABLE, TASK_STATUS_STARTABLE, taskStatusColor, taskStatusLabel } from "../motor-v2/src/shared/task-statuses"
import TaskCodeViewer from "./TaskCodeViewer"
import OperationalFeedPanel from "./OperationalFeedPanel"
import { feedItemFromEnvelope, mergeFeedItem, normalizeFeedSnapshot } from "./operational-feed-adapter"

export const componentId = "gerenteagentes-operation-map"

interface Task { id: number; titulo: string; descricao?: string | null; tipo?: string | null; status: string; projetoId: number; dependsOnTaskId?: number | null; createdAt?: string; updatedAt?: string; subtaskCount?: number; recoveryEligibility?: RecoveryEligibility | null }
interface DbSubtask { id: number; seq: number; titulo: string; descricao?: string | null; scope?: string | null; acceptanceCriteria?: unknown; status: string; resultado?: string | null; dependsOnSubtaskId?: number | null; workspaceStatus?: string | null; correctionForSubtaskId?: number | null }
interface MotorSubtask { id?: number; seq: number; title: string; status: string; deliverCount?: number; blockInfo?: { reason?: string; command?: string; exitCode?: number | null } | null; scope?: string | null; acceptanceCriteria?: unknown; resultado?: string | null; dependsOnSubtaskId?: number | null; workspaceStatus?: string | null; correctionForSubtaskId?: number | null; deliveryHistory?: Array<{ id: number; deliverNumber: number; model: string | null; eventType: string; reason: string | null; createdAt: string }> }
interface Detail { motorId?: string; exists: boolean; message?: string; task?: { status: string; title: string; errorMessage?: string; blockInfo?: { kind?: string; excerpt?: string; blockedAt?: string; subtaskId?: number | null } | null; promotionConflictAnalysis?: import('./ConflictViewer').PromotionConflictData | null; recoveryEligibility?: RecoveryEligibility | null }; subtasks?: MotorSubtask[]; currentSubTask?: MotorSubtask | null; events?: Array<{ at: string; type: string; payload?: Record<string, unknown> }> }
interface MotorOperation { operationId: string; sequence: number; phase: string; outcome: string; messageType: string; commandCode?: string | null; policyCode?: string | null; policyVersion?: number | null; actionCode?: string | null; primitiveCode?: string | null; reasonCode?: string | null; resultJson?: unknown; durationMs?: number | null; createdAt: string }
interface ChatMessage { id: number; tarefaId?: number; role: string; texto: string; createdAt: string; deliveryId?: number | null; deliveryState?: string | null; deliveryError?: string | null }
interface Session { sessionKey: string; model?: string; status?: string; executionOrder?: number; openedAt?: string; closedAt?: string | null; closeReason?: string | null; messages: { items: Array<{ role: string; text: string; sequenceNumber: number }>; nextCursor?: string | null; hasNextPage?: boolean } }
interface SessionsResponse { available: boolean; sessions: Session[] }
interface DeployDiagnostics { canStart: boolean; reasons: string[]; pendingRequests: number }
interface MotorState { active: boolean }

const EMPTY_FILTERS: FiltrosMapa = { busca: "", status: [], projetoId: "", prioridade: "" }
const FINAL_STATUSES = TASK_STATUS_FINAIS
const AWAITING_STATUSES = new Set(["awaiting_clarification", "paused"])

function selectInitialTask(tasks: Task[]): number | "" {
  if (!tasks.length) return ""
  const awaiting = tasks.filter(t => AWAITING_STATUSES.has(t.status)).sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())
  if (awaiting.length) return awaiting[0].id
  const completed = tasks.filter(t => FINAL_STATUSES.has(t.status)).sort((a, b) => { const au = new Date(a.updatedAt ?? 0).getTime(); const bu = new Date(b.updatedAt ?? 0).getTime(); if (au !== bu) return bu - au; return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime() })
  if (completed.length) return completed[0].id
  return tasks.find(t => !FINAL_STATUSES.has(t.status) && t.status !== "draft")?.id ?? tasks[0]?.id ?? ""
}

function eventLabel(type: string) { return ({ task_started: "Tarefa iniciada", task_completed: "Tarefa concluída", task_deployada: "Deploy realizado", task_status_changed: "Status alterado", task_blocked_baseline: "Bloqueada na triagem", subtask_started: "Subtarefa iniciada", subtask_delivered: "Subtarefa entregue", subtask_verified: "Subtarefa verificada", model_escalated: "Modelo escalado" } as Record<string, string>)[type] ?? type }
function criteria(value: unknown): string[] { if (Array.isArray(value)) return value.map(String); if (typeof value !== "string" || !value.trim()) return []; try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : [value] } catch { return value.split("\n").filter(Boolean) } }

export default function OperationMapScreen() {
  const theme = useTheme()
  const isWideScreen = useMediaQuery(theme.breakpoints.up("lg"))
  const bundle = useApi()
  const [tasks, setTasks] = useState<Task[]>([]); const [projects, setProjects] = useState<Array<{ id: number; nome: string }>>([])
  const [selectedId, setSelectedId] = useState<number | "">(""); const [detail, setDetail] = useState<Detail | null>(null); const [operations, setOperations] = useState<MotorOperation[]>([]); const [dbSubtasks, setDbSubtasks] = useState<DbSubtask[]>([])
  const [chat, setChat] = useState<ChatMessage[]>([]); const [chatInput, setChatInput] = useState(""); const [chatLoading, setChatLoading] = useState(false); const [chatSending, setChatSending] = useState(false); const [chatWaiting, setChatWaiting] = useState(false); const [chatError, setChatError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false); const [tab, setTab] = useState(0); const [filters, setFilters] = useState<FiltrosMapa>(EMPTY_FILTERS); const [activities, setActivities] = useState<MotorActivity[]>([]); const [diagnostics, setDiagnostics] = useState<DeployDiagnostics | null>(null); const [realtime, setRealtime] = useState<"connecting" | "open" | "closed">("closed"); const [error, setError] = useState<string | null>(null); const [tasksLoading, setTasksLoading] = useState(true); const [tasksError, setTasksError] = useState<string | null>(null); const [bulkMessage, setBulkMessage] = useState<string | null>(null); const [bulkAction, setBulkAction] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false); const [newTaskLoading, setNewTaskLoading] = useState(false); const [newTaskError, setNewTaskError] = useState<string | null>(null); const [editOpen, setEditOpen] = useState(false); const [editLoading, setEditLoading] = useState(false); const [editError, setEditError] = useState<string | null>(null); const [acaoTarefa, setAcaoTarefa] = useState<"cancel" | "delete" | null>(null)
  const [sessionOpen, setSessionOpen] = useState(false); const [sessionLoading, setSessionLoading] = useState(false); const [sessionError, setSessionError] = useState<string | null>(null); const [sessions, setSessions] = useState<Session[]>([]); const [sessionTitle, setSessionTitle] = useState(""); const [sessionSubtaskSeq, setSessionSubtaskSeq] = useState<number | null>(null); const [sessionPageLoading, setSessionPageLoading] = useState<Set<string>>(new Set()); const [sessionPageErrors, setSessionPageErrors] = useState<Record<string, string>>({}); const sessionPageLoadingRef = useRef(new Set<string>()); const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set()); const [editingSub, setEditingSub] = useState<DbSubtask | null>(null); const [editSubOpen, setEditSubOpen] = useState(false); const [editSubLoading, setEditSubLoading] = useState(false); const [editSubError, setEditSubError] = useState<string | null>(null)
  const [detailMinimized, setDetailMinimized] = useState(false)
  const [codeViewerOpen, setCodeViewerOpen] = useState(false)
  const activeTask = useRef<number | "">(""); const requestId = useRef(0)
  const initialSelectionDone = useRef(false)

  const renderSubtaskExecutionInfo = (sub: MotorSubtask) => <>
    {sub.blockInfo?.reason && <Alert severity="error" data-testid={`subtask-block-${sub.seq}`} sx={{ mt: 1, py: 0 }}>
      Motivo do bloqueio: {sub.blockInfo.reason}
    </Alert>}
    {sub.resultado && <Box data-testid={`subtask-result-${sub.seq}`} sx={{ mt: 1, maxHeight: "220px", overflowY: "auto", p: 1.25, color: "#fff", bgcolor: "rgba(255, 255, 255, 0.08)", border: "1px solid rgba(255, 255, 255, 0.24)", borderRadius: 1, fontSize: "0.9375rem", fontFamily: '"Inter", "Roboto", "Helvetica Neue", Arial, sans-serif', lineHeight: 1.6, fontWeight: 400, letterSpacing: "0.01em" }}>
      <Typography variant="caption" color="success.light" display="block">Resultado da execução</Typography>
      Resultado: {sub.resultado}
    </Box>}
  </>

  // Estado do motor — contrato real do motor-v3 (WorkerActivityResponse)
  const [motorIsRunning, setMotorIsRunning] = useState(false)
  const [motorActivity, setMotorActivity] = useState<AgentStatusStripProps["motorActivity"]>(null)
  const [workers, setWorkers] = useState<AgentStatusStripProps["workers"]>([])
  const [operationalFeed, setOperationalFeed] = useState<import("../api/operational-feed").OperationalFeedItem[]>([])
  const [feedRealtime, setFeedRealtime] = useState<"connecting" | "open" | "closed">("closed")
  const [feedRecovered, setFeedRecovered] = useState(false)
  const feedProjectRef = useRef<number | null>(null)
  // Estado do canal "map" — atualização da lista de tarefas por WebSocket
  const [mapRealtime, setMapRealtime] = useState<"connecting" | "open" | "closed">("closed")
  const [mapRecovered, setMapRecovered] = useState(false)
  const mapProjectRef = useRef<number | null>(null)
  const mapLastSequenceRef = useRef<number | undefined>(undefined)

  const loadTasks = useCallback(async () => { if (!bundle) { setTasksLoading(false); setTasksError("A conexão com a API ainda não está disponível."); return } setTasksLoading(true); setTasksError(null); try { const result = await bundle.http.request<Task[] | { items?: Task[] }>("GET", "/gerenteagentes/tarefas-com-status", { query: { pageSize: 100 }, auth: "access" }); const payload = Array.isArray(result) ? result : (result.items ?? []); const list = payload.sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()); setTasks(list); setSelectedId(current => { if (current !== "" && list.some(t => t.id === current)) return current; if (!initialSelectionDone.current) { initialSelectionDone.current = true; return selectInitialTask(list) } return list.find(t => !FINAL_STATUSES.has(t.status) && t.status !== "draft")?.id ?? list[0]?.id ?? "" }) } catch (e) { setTasksError(e instanceof Error ? e.message : "Não foi possível carregar as tarefas do mapa.") } finally { setTasksLoading(false) } }, [bundle])
  const loadProjects = useCallback(async () => { if (!bundle) return; try { const result = await bundle.http.request<{ items: Array<{ id: number; nome: string }> }>("GET", "/gerenteagentes/projetos_captados", { query: { pageSize: 100 }, auth: "access" }); setProjects(result.items ?? []) } catch { setProjects([]) } }, [bundle])
  const [motorActive, setMotorActive] = useState(true)
  const loadActivity = useCallback(async () => {
    if (!bundle) return
    try {
      const result = await bundle.http.request<{
        motor?: {
          isActive?: boolean
          isRunning?: boolean
          activity?: { kind: "testing" | "worktree" | "deploying" | "executing"; message: string; taskIds: string[] } | null
        }
        workers?: AgentStatusStripProps["workers"]
      }>("GET", "/gerenteagentes/motor-activity", { auth: "access" })
      setMotorActive(result.motor?.isActive ?? true)
      setMotorIsRunning(result.motor?.isRunning ?? false)
      setMotorActivity(result.motor?.activity ?? null)
      setWorkers(result.workers ?? [])
    } catch {
      setMotorIsRunning(false)
      setMotorActivity(null)
      setWorkers([])
    }
  }, [bundle])
  const feedProjectId = tasks.find(task => task.id === selectedId)?.projetoId ?? tasks[0]?.projetoId ?? null
  const loadOperationalFeed = useCallback(async (projectId: number) => {
    if (!bundle) return
    try {
      const result = await bundle.http.request<import("../api/operational-feed").OperationalFeedSnapshot>("GET", "/gerenteagentes/operational-feed", { query: { limit: 100 }, auth: "access" })
      if (feedProjectRef.current === projectId) {
        setOperationalFeed(normalizeFeedSnapshot(result))
        setFeedRecovered(true)
      }
    } catch {
      if (feedProjectRef.current === projectId) setFeedRecovered(false)
    }
  }, [bundle])
  const loadDetail = useCallback(async (id: number) => { if (!bundle) return; try { const result = await bundle.http.request<Detail>("GET", `/gerenteagentes/tarefas/${id}/motor-detail`, { auth: "access" }); setDetail(result) } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível carregar os detalhes.") } }, [bundle])
  const loadOperations = useCallback(async (id: number) => { if (!bundle) return; try { const result = await bundle.http.request<MotorOperation[]>("GET", `/gerenteagentes/tarefas/${id}/operacoes-motor`, { auth: "access" }); setOperations(Array.isArray(result) ? result : []) } catch { setOperations([]) } }, [bundle])
  const loadSubtasks = useCallback(async (id: number) => { if (!bundle) return; try { const result = await bundle.http.request<DbSubtask[]>("GET", `/gerenteagentes/tarefas/${id}/subtarefas`, { auth: "access" }); setDbSubtasks(Array.isArray(result) ? result : []) } catch { setDbSubtasks([]) } }, [bundle])
  const loadChat = useCallback(async (id: number) => { if (!bundle) return; const current = ++requestId.current; setChatLoading(true); setChatError(null); try { const result = await bundle.http.request<ChatMessage[] | { items?: ChatMessage[] }>("GET", `/gerenteagentes/tarefas/${id}/chat`, { auth: "access" }); if (current === requestId.current) { const incoming = Array.isArray(result) ? result : result.items ?? []; setChat(old => [...new Map([...incoming, ...old].map(m => [m.id, m])).values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())); if (incoming.some(m => ["assistant", "agent", "analyst"].includes(m.role))) setChatWaiting(false) } } catch (e) { if (current === requestId.current) setChatError(e instanceof Error ? e.message : "Não foi possível carregar o chat.") } finally { if (current === requestId.current) setChatLoading(false) } }, [bundle])
  const refreshSelected = useCallback(async (id: number) => { await Promise.all([loadDetail(id), loadOperations(id), loadSubtasks(id), loadChat(id)]) }, [loadDetail, loadOperations, loadSubtasks, loadChat])

  // Carga inicial (REST) — projetos, tarefas, atividade do motor
  // A atualização posterior acontece exclusivamente por WebSocket.
  useEffect(() => { void loadTasks(); void loadProjects(); void loadActivity() }, [loadTasks, loadProjects, loadActivity])

  // Canal "map" — atualização da lista de tarefas e contadores por WebSocket
  // Substitui o polling de 5s. O snapshot inicial vem do servidor; eventos
  // subsequentes atualizam a lista localmente. replay_unavailable dispara
  // uma única reconciliação REST (sem iniciar polling).
  const mapProjectId = tasks.find(task => task.id === selectedId)?.projetoId ?? tasks[0]?.projetoId ?? null
  useEffect(() => {
    if (!bundle || mapProjectId == null) { setMapRealtime("closed"); return }
    const projectId = mapProjectId
    mapProjectRef.current = projectId
    setMapRealtime("connecting")
    let disposed = false
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(), baseUrl: resolveApiBaseUrl(), channel: "map",
      lastSequence: mapLastSequenceRef.current,
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: status => { if (!disposed && mapProjectRef.current === projectId) setMapRealtime(status) },
      onMessage: message => {
        if (disposed || mapProjectRef.current !== projectId) return
        if (message.type === "map_replay_unavailable") {
          // Reconciliação controlada: uma única chamada REST para restaurar o estado
          void loadTasks()
          setMapRecovered(true)
          return
        }
        if (message.type === "map_snapshot") {
          // Snapshot inicial do mapa — converte para o formato local de tarefas
          const snapshotTasks = message.snapshot.tasks ?? []
          const list: Task[] = snapshotTasks.map(st => ({
            id: st.taskId,
            titulo: st.title ?? `Tarefa ${st.taskId}`,
            status: st.status,
            projetoId: message.snapshot.projectId,
            updatedAt: st.updatedAt,
            subtaskCount: st.counters?.total,
          }))
          setTasks(prev => {
            // Preserva seleção atual se ainda existir
            const merged = list.length > 0 ? list : prev
            setSelectedId(current => {
              if (current !== "" && merged.some(t => t.id === current)) return current
              if (!initialSelectionDone.current) { initialSelectionDone.current = true; return selectInitialTask(merged) }
              return merged.find(t => !FINAL_STATUSES.has(t.status) && t.status !== "draft")?.id ?? merged[0]?.id ?? ""
            })
            return merged
          })
          setMapRecovered(true)
          return
        }
        if (message.type === "event") {
          const event = message.event
          const payload = event.payload
          // Atualiza lista de tarefas conforme o tipo de evento
          if (event.type === "task.created") {
            const newTask: Task = {
              id: event.taskId,
              titulo: String(payload.titulo ?? payload.title ?? `Tarefa ${event.taskId}`),
              status: String(payload.status ?? "draft"),
              projetoId: event.projectId,
              updatedAt: event.occurredAt,
              createdAt: event.occurredAt,
            }
            setTasks(prev => {
              if (prev.some(t => t.id === event.taskId)) return prev
              return [newTask, ...prev].sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())
            })
          } else if (event.type === "task.updated") {
            setTasks(prev => prev.map(t => t.id === event.taskId ? {
              ...t,
              titulo: String(payload.titulo ?? payload.title ?? t.titulo),
              status: String(payload.status ?? t.status),
              updatedAt: event.occurredAt,
            } : t))
          } else if (event.type === "task.deleted") {
            setTasks(prev => prev.filter(t => t.id !== event.taskId))
            setSelectedId(current => current === event.taskId ? "" : current)
          } else if (event.type === "task.status.changed") {
            const newStatus = String(payload.status ?? "")
            if (newStatus) {
              setTasks(prev => prev.map(t => t.id === event.taskId ? { ...t, status: newStatus, updatedAt: event.occurredAt } : t))
            }
          } else if (event.type === "task.counters.updated") {
            setTasks(prev => prev.map(t => t.id === event.taskId ? {
              ...t,
              subtaskCount: typeof payload.total === "number" ? payload.total : t.subtaskCount,
              updatedAt: event.occurredAt,
            } : t))
          }
          // O detalhe possui seu próprio canal; o mapa não faz reconciliação
          // REST para eventos normais (somente replay indisponível acima).
        }
      },
    })
    void client.connect()
    return () => { disposed = true; client.close() }
  }, [bundle, mapProjectId, loadTasks, loadDetail, loadOperations, loadSubtasks, selectedId])
  // Canal "task" — atualização do detalhe da tarefa selecionada por WebSocket
  // Eventos de subtarefas, chat, atividades e histórico são aplicados localmente.
  // replay_unavailable dispara uma única reconciliação REST (sem polling).
  useEffect(() => {
    if (!bundle || selectedId === "") {
      activeTask.current = ""
      setRealtime("closed")
      return
    }
    activeTask.current = selectedId
    setRealtime("connecting")
    setChat([])
    setDetail(null)
    setOperations([])
    setDbSubtasks([])
    // Carga inicial do detalhe (REST) — o WebSocket assumirá depois
    void refreshSelected(selectedId)
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(),
      baseUrl: resolveApiBaseUrl(),
      taskId: selectedId,
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: status => {
        if (activeTask.current === selectedId) setRealtime(status)
      },
      onMessage: message => {
        if (activeTask.current !== selectedId) return
        // replay_unavailable: reconciliação controlada (uma única chamada REST)
        if (message.type === "replay_unavailable") {
          void refreshSelected(selectedId)
          return
        }
        // task_snapshot: snapshot completo do detalhe (aplica diretamente)
        if (message.type === "task_snapshot") {
          const snap = message.snapshot
          setDetail({
            exists: true,
            task: snap.task as Detail["task"],
            subtasks: snap.subtasks as MotorSubtask[],
            events: snap.history as Detail["events"],
          })
          if (Array.isArray(snap.chat)) {
            setChat(snap.chat as ChatMessage[])
          }
          return
        }
        if (message.type === "error") {
          setChatError(message.message)
          return
        }
        if (message.type !== "event") return
        const payload = message.event.payload
        const eventType = message.event.type
        // Chat — aplica diretamente sem recarregar
        if (eventType.includes("chat")) {
          const id = Number(payload.id)
          const texto = typeof payload.texto === "string" ? payload.texto : ""
          if (id && texto) {
            setChat(old => old.some(m => m.id === id) ? old : [...old, {
              id,
              tarefaId: selectedId,
              role: String(payload.role ?? "assistant"),
              texto,
              createdAt: String(payload.createdAt ?? message.event.occurredAt),
            }])
            if (String(payload.role) !== "user") setChatWaiting(false)
          } else {
            void loadChat(selectedId)
          }
          return
        }
        // Status da tarefa — atualiza a lista local (map channel também faz, mas aqui garante consistência)
        if (eventType === "task.status.changed" && typeof payload.status === "string") {
          setTasks(old => old.map(t => t.id === selectedId ? { ...t, status: String(payload.status) } : t))
        }
        // Subtarefas — aplica eventos diretamente quando possível
        if (eventType === "subtask.created" || eventType === "subtask.updated" || eventType === "subtask.deleted") {
          void loadSubtasks(selectedId)
        }
        if (eventType === "subtask.status.changed") {
          const subtaskId = Number(message.event.subtaskId ?? payload.id)
          const status = typeof payload.status === "string" ? payload.status : null
          if (subtaskId && status) {
            setDetail(prev => prev ? {
              ...prev,
              subtasks: prev.subtasks?.map(subtask => subtask.id === subtaskId ? { ...subtask, status } : subtask),
            } : prev)
            setDbSubtasks(prev => prev.map(subtask => subtask.id === subtaskId ? { ...subtask, status } : subtask))
          } else {
            void loadSubtasks(selectedId)
          }
        }
        // Atividades e operações — recarrega para manter consistência
        if (eventType === "activity.created" || eventType === "activity.updated") {
          void loadOperations(selectedId)
        }
        // Histórico — adiciona ao estado local
        if (eventType === "history.entry.created") {
          setDetail(prev => {
            if (!prev) return prev
            const newEvent = {
              at: message.event.occurredAt,
              type: String(payload.type ?? eventType),
              payload: payload as Record<string, unknown>,
            }
            return { ...prev, events: [...(prev.events ?? []), newEvent] }
          })
        }
        // Deploy diagnostics
        if (eventType === "deploy.diagnostics.updated") {
          setDiagnostics(prev => ({
            canStart: typeof payload.canStart === "boolean" ? payload.canStart : prev?.canStart ?? true,
            reasons: Array.isArray(payload.reasons) ? payload.reasons.map(String) : prev?.reasons ?? [],
            pendingRequests: typeof payload.pendingRequests === "number" ? payload.pendingRequests : prev?.pendingRequests ?? 0,
          }))
        }
        // Eventos genéricos de tarefa/subtarefa — recarrega o detalhe
        if ((eventType.startsWith("task.") || eventType.startsWith("subtask.")) &&
            !["task.status.changed", "subtask.created", "subtask.updated", "subtask.deleted", "subtask.status.changed"].includes(eventType)) {
          void loadDetail(selectedId)
        }
      },
    })
    void client.connect()
    return () => {
      if (activeTask.current === selectedId) activeTask.current = ""
      client.close()
    }
  }, [bundle, selectedId, refreshSelected, loadChat, loadDetail, loadOperations, loadSubtasks])

  // O quadro inferior acompanha o projeto inteiro. Ele não é resetado quando
  // o usuário troca a tarefa no drawer, evitando misturar históricos de seleção.
  useEffect(() => {
    if (!bundle || feedProjectId == null) { setFeedRealtime("closed"); return }
    const projectId = feedProjectId
    feedProjectRef.current = projectId
    setOperationalFeed([])
    setFeedRecovered(false)
    setFeedRealtime("connecting")
    let disposed = false
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(), baseUrl: resolveApiBaseUrl(), channel: "project-feed",
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: status => { if (!disposed && feedProjectRef.current === projectId) setFeedRealtime(status) },
      onMessage: message => {
        if (disposed || feedProjectRef.current !== projectId) return
        if (message.type === "feed_replay_unavailable") { void loadOperationalFeed(projectId); return }
        if (message.type === "event") {
          const item = feedItemFromEnvelope(message.event)
          if (item && item.projectId === projectId) setOperationalFeed(old => mergeFeedItem(old, item))
        }
      },
    })
    void (async () => { await loadOperationalFeed(projectId); if (!disposed) await client.connect() })()
    return () => { disposed = true; client.close() }
  }, [bundle, feedProjectId, loadOperationalFeed])

  const selected = tasks.find(t => t.id === selectedId); const mapped = useMemo<FlowTask[]>(() => tasks.map(t => ({ ...t, createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null, projetoNome: projects.find(p => p.id === t.projetoId)?.nome ?? null })), [tasks, projects]); const subtasks = detail?.subtasks?.length ? detail.subtasks : dbSubtasks.map(s => ({ id: s.id, seq: s.seq, title: s.titulo, status: s.status, scope: s.scope, acceptanceCriteria: s.acceptanceCriteria, resultado: s.resultado, workspaceStatus: s.workspaceStatus, correctionForSubtaskId: s.correctionForSubtaskId })); const status = detail?.task?.status ?? selected?.status ?? ""; const canStart = status === "paused" || TASK_STATUS_STARTABLE.has(status); const canPause = TASK_STATUS_PAUSABLE.has(status)
  const execute = useCallback(async (action: "start" | "pause" | "resume" | "unlock" | "sanitize-session", id = selectedId) => {
    if (!bundle || id === "") return
    if (action === "sanitize-session" && !window.confirm("Arquivar a sessão atual do agente e preparar uma continuação com contexto limpo? O histórico será preservado. Depois, desbloqueie a tarefa para retomá-la.")) return
    setError(null)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/${action}`, { auth: "access" })
      // A atualização da lista e do detalhe acontece via WebSocket (canal "map" e "task")
      // Não chama loadTasks() aqui — o evento task.status.changed atualizará o estado local.
    } catch (e) {
      setError(e instanceof Error ? e.message : `Erro ao ${action} a tarefa.`)
    }
  }, [bundle, selectedId])
  /**
   * Cancelamento imediato da tarefa. O motor interrompe a execução no próximo
   * ponto seguro e registra o evento em `tarefa_eventos` (trilha de auditoria).
   */
  const cancelarTarefa = useCallback(async (id: number) => {
    if (!bundle || acaoTarefa !== null) return
    if (!window.confirm("Cancelar esta tarefa imediatamente? A execução será interrompida.")) return
    const motivo = window.prompt("Motivo do cancelamento (opcional):")?.trim() || undefined
    setAcaoTarefa("cancel")
    setError(null)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/cancel`, { body: { motivo }, auth: "access" })
      // A atualização acontece via WebSocket (evento task.status.changed no canal "map")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao cancelar a tarefa.")
    } finally {
      setAcaoTarefa(null)
    }
  }, [bundle, acaoTarefa])
  /**
   * Exclusão definitiva da tarefa e dos dados operacionais vinculados
   * (subtarefas, sessões, eventos). Irreversível — exige confirmação explícita.
   */
  const excluirTarefa = useCallback(async (id: number) => {
    if (!bundle || acaoTarefa !== null) return
    if (!window.confirm("Excluir esta tarefa e seus dados operacionais? Esta ação não pode ser desfeita.")) return
    setAcaoTarefa("delete")
    setError(null)
    try {
      await bundle.http.request("DELETE", `/gerenteagentes/tarefas/${id}`, { auth: "access" })
      setDrawerOpen(false)
      setSelectedId("")
      // A atualização da lista acontece via WebSocket (evento task.deleted no canal "map")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao excluir a tarefa.")
    } finally {
      setAcaoTarefa(null)
    }
  }, [bundle, acaoTarefa])
  const confirmarDeploy = useCallback(async (id: number) => {
    if (!bundle || !window.confirm("Confirmar que o deploy foi realizado com sucesso?")) return
    setError(null)
    setAcaoTarefa("confirm-deploy")
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/confirm-deploy`, { auth: "access" })
      // A atualização acontece via WebSocket (evento task.status.changed no canal "map")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao confirmar deploy.")
    } finally {
      setAcaoTarefa(null)
    }
  }, [bundle])
  const bulk = async (action: "pause-all" | "resume-all") => { if (!bundle) return; setBulkAction(action); setBulkMessage(null); try { const result = await bundle.http.request<MotorState>("POST", `/gerenteagentes/tarefas/${action}`, { auth: "access" }); setMotorActive(result.active); setBulkMessage(result.active ? "Motor ativado. Novas atividades voltarão a ser despachadas." : "Motor pausado. Atividades em andamento continuam; novas atividades serão adiadas."); } catch (e) { setBulkMessage(e instanceof Error ? e.message : "Não foi possível alterar o estado do Motor.") } finally { setBulkAction(null) } }
  const sendChat = async (modo: "normal" | "solicitar_pausa" = "normal") => { const text = chatInput.trim(); if (!bundle || selectedId === "" || !text || chatSending) return; const id = selectedId; setChatSending(true); setChatWaiting(true); setChatError(null); try { await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/chat`, { body: { texto: text, modo }, auth: "access" }); if (selectedId === id) { setChatInput(""); await loadChat(id) } } catch (e) { if (selectedId === id) { setChatWaiting(false); setChatError(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.") } } finally { setChatSending(false) } }
  const resumeInteraction = async () => { if (!bundle || selectedId === "") return; setChatSending(true); setChatError(null); try { await bundle.http.request("POST", `/gerenteagentes/tarefas/${selectedId}/interacao/retomar`, { auth: "access" }); await refreshSelected(selectedId) } catch (e) { setChatError(e instanceof Error ? e.message : "Não foi possível retomar a execução.") } finally { setChatSending(false) } }

  const renderHeaderActions = () => (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      <Button size="small" variant="contained" startIcon={<PlayArrowRounded />} disabled={!canStart} onClick={() => void execute("start")} data-testid="header-btn-start">Iniciar</Button>
      <Button size="small" variant="outlined" startIcon={<PauseRounded />} disabled={!canPause} onClick={() => void execute("pause")} data-testid="header-btn-pause">Pausar</Button>
      <Button size="small" variant="outlined" startIcon={<ReplayRounded />} disabled={status !== "paused"} onClick={() => void execute("resume")} data-testid="header-btn-resume">Retomar</Button>
      <Button size="small" variant="outlined" startIcon={<LockOpenRounded />} disabled={status !== "blocked"} onClick={() => void execute("unlock")} data-testid="header-btn-unlock">Desbloquear</Button>
      <Tooltip title="Arquivar a sessão do agente e preparar uma continuação com contexto limpo"><span><Button size="small" variant="outlined" startIcon={<ReplayRounded />} disabled={TASK_STATUS_EXECUTING.has(status)} onClick={() => void execute("sanitize-session")} data-testid="header-btn-sanitize">Sanear sessão</Button></span></Tooltip>
      {status === "completed" && <span data-testid="header-btn-confirm-deploy"><Button size="small" color="success" variant="contained" startIcon={<LockOpenRounded />} disabled={acaoTarefa !== null} onClick={() => void confirmarDeploy(selected.id)} data-testid="btn-confirm-deploy">Confirmar Deploy</Button></span>}
      <span data-testid="header-btn-cancel"><Button size="small" color="error" variant="outlined" startIcon={<CloseRounded />} disabled={acaoTarefa !== null || FINAL_STATUSES.has(status) || status === "cancelled" || status === "closed"} onClick={() => void cancelarTarefa(selected.id)} data-testid="btn-cancel">Cancelar</Button></span>
      <span data-testid="header-btn-delete"><Button size="small" color="error" variant="text" startIcon={<DeleteRounded />} disabled={acaoTarefa !== null || TASK_STATUS_EXECUTING.has(status)} onClick={() => void excluirTarefa(selected.id)} data-testid="btn-delete">Excluir</Button></span>
      <Button size="small" variant="text" startIcon={<EditRounded />} onClick={() => setEditOpen(true)}>Editar</Button>
      <Button size="small" variant="text" startIcon={<PsychologyRounded />} onClick={() => void openSessions()}>Sessões</Button>
      {detail?.exists && <Button size="small" variant="text" startIcon={<CodeRounded />} onClick={() => setCodeViewerOpen(true)}>Ver código</Button>}
    </Stack>
  )

  const renderSummaryTab = () => {
    const blockInfo = detail?.task?.blockInfo
    const conflictData = detail?.task?.promotionConflictAnalysis
    const isMergeConflict = blockInfo?.kind === 'merge_conflict' && conflictData

    return (
      <Stack spacing={1.5}>
        <Typography color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>{selected.descricao || "Sem descrição"}</Typography>
        {blockInfo && !isMergeConflict && <Alert severity="error"><b>Bloqueio:</b> {blockInfo.excerpt || blockInfo.kind || detail?.task?.errorMessage}</Alert>}
        {isMergeConflict && conflictData && (
          <Alert severity="error" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" gutterBottom>
              <strong>Conflito de merge detectado no deploy</strong>
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>O que aconteceu:</strong> O motor tentou promover o commit para a branch {conflictData.baseBranch}, mas encontrou conflitos reais com mudanças na base.
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Etapa:</strong> Promoção para branch de integração (git merge)
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Branch de origem:</strong> <code>{conflictData.taskBranch}</code>
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Branch de destino:</strong> <code>{conflictData.baseBranch}</code>
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Commit da tarefa:</strong> <code>{conflictData.taskCommit.slice(0, 8)}</code>
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Arquivos conflitantes ({conflictData.conflictFiles.length}):</strong>
            </Typography>
            <Box component="ul" sx={{ ml: 2, mt: 0.5, mb: 0.5 }}>
              {conflictData.conflictFiles.map((file) => (
                <Box component="li" key={file}>
                  <Typography variant="caption" component="code" sx={{ fontSize: '0.7rem' }}>{file}</Typography>
                </Box>
              ))}
            </Box>
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              <strong>Ação necessária:</strong> Rebase ou merge manual da branch {conflictData.baseBranch} na branch de trabalho, resolvendo os conflitos nos arquivos listados.
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={<CodeRounded />}
              onClick={() => setCodeViewerOpen(true)}
              sx={{ mt: 1 }}
            >
              Ver Conflitos
            </Button>
          </Alert>
        )}
        {detail && !detail.exists && <Alert severity="info">{detail.message ?? "Tarefa ainda não enviada ao motor."}</Alert>}
      </Stack>
    )
  }

  const openTask = (id: number) => {
    if (id === selectedId) {
      if (!drawerOpen) setDrawerOpen(true)
      return
    }
    setSelectedId(id)
    setDrawerOpen(true)
    setTab(0)
    setDetailMinimized(false)
  }
  const createTask = async (values: TarefaFormValues) => {
    if (!bundle) return
    setNewTaskLoading(true)
    setNewTaskError(null)
    try {
      await bundle.http.request("POST", "/gerenteagentes/tarefas", {
        body: { projeto_id: Number(values.projetoId), titulo: values.titulo, descricao: values.descricao || null, tipo: values.tipo },
        auth: "access",
      })
      setNewTaskOpen(false)
      // A atualização da lista acontece via WebSocket (evento task.created no canal "map")
    } catch (e) {
      setNewTaskError(e instanceof Error ? e.message : "Erro ao criar tarefa")
      throw e
    } finally {
      setNewTaskLoading(false)
    }
  }
  const getLoadOptions = useCallback((resource: string) => async (search: string) => { if (!bundle) return []; try { const result = await bundle.http.request<{ items: Array<Record<string, unknown>> }>("GET", `/${resource}`, { query: search ? { search, pageSize: 50 } : { pageSize: 100 }, auth: "access" }); return result.items ?? [] } catch { return [] } }, [bundle])
  const editFields: DynamicField[] = useMemo(() => [{ name: "titulo", label: "Título", type: "text", required: true, maxLength: 200, fullWidth: true }, { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true }, { name: "tipo", label: "Tipo de tarefa", type: "select", options: [{ value: "desenvolvimento", label: "Desenvolvimento" }, { value: "automacao", label: "Automação" }, { value: "verificacao", label: "Verificação" }] }, { name: "dependsOnTaskId", label: "Depende da tarefa", type: "multipleChoice", multipleChoice: { resource: "tarefas", idField: "id", displayField: "titulo", loadOptions: getLoadOptions("tarefas") } }], [getLoadOptions])
  const editTask = async (values: DynamicFormValues) => {
    if (!bundle || !selected) return
    setEditLoading(true)
    setEditError(null)
    try {
      await bundle.http.request("PUT", `/gerenteagentes/tarefas/${selected.id}`, {
        body: {
          titulo: String(values.titulo ?? "").trim(),
          descricao: values.descricao ? String(values.descricao).trim() : null,
          tipo: String(values.tipo ?? "desenvolvimento"),
          dependsOnTaskId: values.dependsOnTaskId !== "" && values.dependsOnTaskId != null ? Number(values.dependsOnTaskId) : null,
        },
        auth: "access",
      })
      setEditOpen(false)
      // A atualização acontece via WebSocket (evento task.updated no canal "map")
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Erro ao editar tarefa")
    } finally {
      setEditLoading(false)
    }
  }
  const openSessions = async (subtask?: MotorSubtask) => { if (!bundle || selectedId === "") return; setSessionSubtaskSeq(subtask?.seq ?? null); setSessionTitle(subtask ? `Sessão da subtarefa #${subtask.seq}` : "Sessões do analista"); setSessionOpen(true); setSessionLoading(true); setSessionError(null); setSessionPageLoading(new Set()); setSessionPageErrors({}); sessionPageLoadingRef.current.clear(); try { const path = subtask ? `/gerenteagentes/tarefas/${selectedId}/subtarefas/${subtask.seq}/sessao` : `/gerenteagentes/tarefas/${selectedId}/sessoes-analista`; const result = await bundle.http.request<SessionsResponse>("GET", path, { auth: "access" }); setSessions(result.sessions ?? []) } catch (e) { setSessionError(e instanceof Error ? e.message : "Não foi possível carregar as sessões.") } finally { setSessionLoading(false) } }
  const loadMoreSession = useCallback(async (session: Session) => { if (!bundle || selectedId === "" || !session.messages.hasNextPage || !session.messages.nextCursor || sessionPageLoadingRef.current.has(session.sessionKey)) return; const key = session.sessionKey; sessionPageLoadingRef.current.add(key); setSessionPageLoading(old => new Set(old).add(key)); setSessionPageErrors(old => { const next = { ...old }; delete next[key]; return next }); try { const path = sessionSubtaskSeq == null ? `/gerenteagentes/tarefas/${selectedId}/sessoes-analista` : `/gerenteagentes/tarefas/${selectedId}/subtarefas/${sessionSubtaskSeq}/sessao`; const result = await bundle.http.request<SessionsResponse>("GET", path, { query: { sessionKey: key, cursor: session.messages.nextCursor }, auth: "access" }); const page = result.sessions.find(item => item.sessionKey === key)?.messages; if (page) setSessions(old => old.map(item => item.sessionKey === key ? { ...item, messages: { ...item.messages, items: [...item.messages.items, ...page.items].sort((a, b) => b.sequenceNumber - a.sequenceNumber), nextCursor: page.nextCursor, hasNextPage: page.hasNextPage } } : item)) } catch (e) { setSessionPageErrors(old => ({ ...old, [key]: e instanceof Error ? e.message : "Não foi possível carregar mais mensagens." })) } finally { sessionPageLoadingRef.current.delete(key); setSessionPageLoading(old => { const next = new Set(old); next.delete(key); return next }) } }, [bundle, selectedId, sessionSubtaskSeq])
  const handleSessionScroll = useCallback((event: React.UIEvent<HTMLElement>, session: Session) => { const element = event.currentTarget; if (element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMoreSession(session) }, [loadMoreSession])
  const editSubFields: DynamicField[] = useMemo(() => [{ name: "titulo", label: "Título", type: "text", required: true, fullWidth: true }, { name: "status", label: "Status", type: "select", options: SUBTASK_STATUS_OPTIONS }, { name: "seq", label: "Ordem", type: "number", min: 0 }, { name: "scope", label: "Escopo", type: "textarea", required: true, fullWidth: true }, { name: "acceptance_criteria", label: "Critérios de aceite (um por linha)", type: "textarea", fullWidth: true }, { name: "resultado", label: "Resultado", type: "textarea", fullWidth: true }, { name: "dependsOnSubtaskId", label: "Depende da subtarefa", type: "multipleChoice", multipleChoice: { resource: "subtarefas", idField: "id", displayField: "titulo", loadOptions: getLoadOptions("subtarefas") } }], [getLoadOptions])
  const saveSubtask = async (values: DynamicFormValues) => {
    if (!bundle || !editingSub) return
    const scope = String(values.scope ?? "").trim()
    if (!scope) { setEditSubError("O escopo é obrigatório."); return }
    setEditSubLoading(true)
    setEditSubError(null)
    try {
      await bundle.http.request("PUT", `/gerenteagentes/subtarefas/${editingSub.id}`, {
        body: {
          titulo: String(values.titulo ?? "").trim(),
          status: String(values.status ?? editingSub.status),
          seq: Number(values.seq ?? editingSub.seq),
          scope,
          acceptance_criteria: String(values.acceptance_criteria ?? "").split("\n").map(s => s.trim()).filter(Boolean),
          resultado: values.resultado ? String(values.resultado).trim() : null,
          dependsOnSubtaskId: values.dependsOnSubtaskId !== "" && values.dependsOnSubtaskId != null ? Number(values.dependsOnSubtaskId) : null,
        },
        auth: "access",
      })
      setEditSubOpen(false)
      setEditingSub(null)
      // A atualização acontece via WebSocket (evento subtask.updated no canal "task")
    } catch (e) {
      setEditSubError(e instanceof Error ? e.message : "Erro ao editar subtarefa")
    } finally {
      setEditSubLoading(false)
    }
  }

  if (tasksLoading && tasks.length === 0) return <Box data-testid="operation-map-screen" sx={{ width: "100%", display: "flex", justifyContent: "center", p: 4 }}><CircularProgress aria-label="Carregando tarefas" /></Box>
  return <Box data-testid="operation-map-screen" sx={{ width: "100%", maxWidth: 1800, mx: "auto", display: "flex", flexDirection: { xs: "column", lg: "row" }, gap: 2, alignItems: "flex-start", position: "relative" }}>
    <Stack spacing={1.5} sx={{ flex: 1, minWidth: 0, width: "100%" }}>
    <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }}>
      <Box><Typography variant="h4" fontWeight={750}>Mapa de agentes</Typography><Typography variant="body2" color="text.secondary">Controle operacional em tempo real</Typography></Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap><Typography variant="caption" color={realtime === "open" ? "success.main" : "warning.main"}>● {realtime === "open" ? "Tempo real conectado" : "Reconectando…"}</Typography><Typography variant="body2"><b>{tasks.length}</b> tarefas</Typography><Typography variant="body2" color="primary.main"><b>{tasks.filter(t => ["running", "analyzing", "motor_fix"].includes(t.status)).length}</b> executando</Typography><Tooltip title="Impede novas atividades sem interromper o que já está em execução"><span><Button size="small" variant="outlined" startIcon={<PauseRounded />} disabled={bulkAction !== null || !motorActive} onClick={() => void bulk("pause-all")}>Pausar Motor</Button></span></Tooltip><Tooltip title="Reativa o despacho de novas atividades"><span><Button size="small" variant="outlined" startIcon={<ReplayRounded />} disabled={bulkAction !== null || motorActive} onClick={() => void bulk("resume-all")}>Ativar Motor</Button></span></Tooltip><Button variant="contained" size="small" startIcon={<AddTaskRounded />} onClick={() => setNewTaskOpen(true)}>Nova tarefa</Button></Stack>
    </Stack>
    {/* Faixa de status dos agentes */}
    <AgentStatusStrip motorActive={motorActive} motorIsRunning={motorIsRunning} motorActivity={motorActivity} workers={workers} />
    {tasksError && <Alert severity="error" onClose={() => setTasksError(null)}>Não foi possível carregar as tarefas do mapa: {tasksError}</Alert>}{!tasksLoading && !tasksError && tasks.length === 0 && <Alert severity="info">Nenhuma tarefa encontrada.</Alert>}{error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}{bulkMessage && <Alert severity="info" onClose={() => setBulkMessage(null)}>{bulkMessage}</Alert>}{diagnostics && <Tooltip title={diagnostics.reasons.join(" · ")}><Alert severity={diagnostics.canStart ? "success" : diagnostics.pendingRequests ? "warning" : "info"} sx={{ py: 0.5 }}>{diagnostics.canStart ? "Deploy pronto para iniciar" : diagnostics.reasons[0] ?? "Deploy aguardando condições operacionais"}{diagnostics.pendingRequests > 0 ? ` · ${diagnostics.pendingRequests} pendente(s)` : ""}</Alert></Tooltip>}
    <OperationMapCanvas tarefas={mapped} selectedTaskId={selectedId} motorActivities={activities} projetos={projects} filtros={filters} onFiltrosChange={setFilters} onSelectTask={openTask} />
    <OperationalFeedPanel items={operationalFeed} connection={feedRealtime} recovered={feedRecovered} onSelectTask={openTask} />
    </Stack>

    {isWideScreen && selected && (
      <Box sx={{ width: { lg: 480 }, flexShrink: 0, position: "sticky", top: 16, alignSelf: "flex-start", maxHeight: "calc(100vh - 32px)" }} data-testid="detail-panel-wide">
        <Paper variant="outlined" sx={{ display: "flex", flexDirection: "column", height: "calc(100vh - 32px)", overflow: "hidden" }} data-testid="detail-content">
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ p: 2, pb: 1 }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h6" noWrap>#{selected.id} {selected.titulo}</Typography>
              <Stack direction="row" spacing={.75} sx={{ mt: .75 }} flexWrap="wrap" useFlexGap>
                <Chip size="small" label={taskStatusLabel(status)} color={taskStatusColor(status)} />
                {selected.tipo && <Chip size="small" variant="outlined" label={selected.tipo} />}
                {status === "awaiting_clarification" && <Chip size="small" color="warning" label="Resposta necessária" />}
                {status === "blocked" && (detail?.task?.recoveryEligibility ?? selected.recoveryEligibility) && <Tooltip title={<RecoveryEligibilityTooltipContent eligibility={(detail?.task?.recoveryEligibility ?? selected.recoveryEligibility)!} />}><Chip size="small" color="warning" label={recoveryEligibilityLabel((detail?.task?.recoveryEligibility ?? selected.recoveryEligibility)!)} /></Tooltip>}
              </Stack>
            </Box>
          </Stack>
          <Divider />
          <Box sx={{ px: 2, py: 1.5, flexShrink: 0 }}>{renderHeaderActions()}</Box>
          <Divider />
          <Tabs sx={{ px: 1, flexShrink: 0 }} value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" aria-label="Detalhes da tarefa"><Tab label="Resumo" /><Tab label="Chat" /><Tab label="Execução" /><Tab label="Logs" /><Tab label="Histórico" /></Tabs>
          <Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
            {tab === 0 && renderSummaryTab()}
            {tab === 1 && <Stack spacing={1.5}><Stack direction="row" spacing={.75} flexWrap="wrap" useFlexGap><Chip size="small" color={status === "awaiting_interaction" ? "warning" : "default"} label={status === "awaiting_interaction" ? "Aguardando você" : chatWaiting ? "Checkpoint pendente" : "Pronto para conversar"} />{status !== "awaiting_interaction" && <Typography variant="caption" color="text.secondary" sx={{ alignSelf: "center" }}>Mensagens durante a execução serão entregues no próximo checkpoint seguro.</Typography>}</Stack><Box data-testid="operation-chat-history" sx={{ minHeight: 160, maxHeight: "40vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 1, p: 1, bgcolor: "background.default", borderRadius: 1 }}>{chatLoading && <CircularProgress size={22} />}{chatError && <Alert severity="error">{chatError}</Alert>}{!chatLoading && !chat.length && !chatError && <Typography color="text.secondary" align="center">Nenhuma mensagem ainda.</Typography>}{chat.map(message => <Box key={message.id} sx={{ alignSelf: ["assistant", "agent", "analyst"].includes(message.role) ? "flex-start" : "flex-end", maxWidth: "90%", p: 1.25, borderRadius: 1.5, bgcolor: ["assistant", "agent", "analyst"].includes(message.role) ? "action.hover" : "primary.main", color: ["assistant", "agent", "analyst"].includes(message.role) ? "text.primary" : "primary.contrastText" }}><Typography variant="caption" display="block">{["assistant", "agent", "analyst"].includes(message.role) ? "Agente" : "Você"} · {new Date(message.createdAt).toLocaleString("pt-BR")}</Typography><Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message.texto}</Typography></Box>)}</Box>{chatWaiting && <Typography variant="caption" color="text.secondary">Mensagem aguardando resposta do agente…</Typography>}{realtime !== "open" && <Typography variant="caption" color="warning.main">Tempo real indisponível; tentando reconectar…</Typography>}<Stack direction="row" spacing={1} alignItems="flex-start"><TextField fullWidth multiline minRows={2} maxRows={5} placeholder="Conversar com o agente…" value={chatInput} disabled={chatSending} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendChat() } }} inputProps={{ "data-testid": "operation-chat-input", maxLength: 8000 }} helperText={`${chatInput.length}/8000 · Ctrl+Enter para enviar`} /><Stack spacing={.75}><Button variant="contained" disabled={!chatInput.trim() || chatSending} onClick={() => void sendChat()} startIcon={chatSending ? <CircularProgress size={16} /> : <SendRounded />}>Enviar</Button><Button size="small" variant="outlined" disabled={!chatInput.trim() || chatSending || status === "awaiting_interaction"} onClick={() => void sendChat("solicitar_pausa")} startIcon={<PauseRounded />}>Pausar e conversar</Button>{status === "awaiting_interaction" && <Button size="small" variant="outlined" disabled={chatSending} onClick={() => void resumeInteraction()} startIcon={<ReplayRounded />}>Retomar execução</Button>}</Stack></Stack></Stack>}
            {tab === 2 && <Stack spacing={1}>{subtasks.map(sub => <Paper key={sub.seq} variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="body2" fontWeight={600}>{sub.seq}. {sub.id != null ? `[#${sub.id}] ` : ""}{sub.title}</Typography>{sub.scope && <Typography variant="caption" color="text.secondary">{sub.scope}</Typography>}<Typography variant="caption" display="block" color="text.secondary">Critérios: {criteria(sub.acceptanceCriteria).length} · Entregas: {sub.deliverCount ?? 0}{sub.workspaceStatus ? ` · Workspace: ${sub.workspaceStatus}` : ""}</Typography></Box><Stack direction="row" spacing={.5} alignItems="center"><Chip size="small" label={taskStatusLabel(sub.status)} color={taskStatusColor(sub.status)} />{sub.deliveryHistory?.length ? <IconButton size="small" aria-label="Ver histórico de entregas" onClick={() => setExpandedHistory(old => { const next = new Set(old); if (next.has(sub.seq)) next.delete(sub.seq); else next.add(sub.seq); return next })}>{expandedHistory.has(sub.seq) ? <ExpandLessRounded /> : <ExpandMoreRounded />}</IconButton> : null}<IconButton size="small" aria-label={`Editar subtarefa ${sub.seq}`} onClick={() => { const db = dbSubtasks.find(item => item.seq === sub.seq); if (db) { setEditingSub(db); setEditSubError(null); setEditSubOpen(true) } }}><EditRounded /></IconButton><IconButton size="small" aria-label={`Visualizar sessão da subtarefa ${sub.seq}`} onClick={() => void openSessions(sub)}><VisibilityRounded /></IconButton></Stack></Stack>{renderSubtaskExecutionInfo(sub)}{expandedHistory.has(sub.seq) && sub.deliveryHistory?.map(h => <Typography key={h.id} variant="caption" display="block" sx={{ mt: .5 }}>{h.deliverNumber}. {eventLabel(h.eventType)} · {h.model ?? "—"} · {h.reason ?? "sem motivo"}</Typography>)}</Paper>)}{!subtasks.length && <Typography color="text.secondary">Nenhuma subtarefa disponível.</Typography>}</Stack>}
            {tab === 3 && <Stack spacing={.75}>{operations.map(operation => <Box key={`${operation.operationId}-${operation.sequence}`} sx={{ borderBottom: "1px dashed", borderColor: "divider", pb: .75 }}><Typography variant="caption" color="text.secondary">{new Date(operation.createdAt).toLocaleString("pt-BR")} · {operation.phase} / {operation.outcome}</Typography><Typography variant="body2">{operation.commandCode ?? operation.messageType}{operation.actionCode ? ` → ${operation.actionCode}` : ""}{operation.primitiveCode ? ` → ${operation.primitiveCode}` : ""}</Typography>{operation.policyCode && <Typography variant="caption" display="block">Política: {operation.policyCode} v{operation.policyVersion ?? 1}</Typography>}{operation.reasonCode && <Typography variant="caption" display="block" color="warning.main">Motivo: {operation.reasonCode}</Typography>}{operation.resultJson && <Typography variant="caption" display="block" color="text.secondary">{JSON.stringify(operation.resultJson).slice(0, 300)}</Typography>}</Box>)}{!operations.length && <Typography color="text.secondary">Nenhuma operação do Motor v3 registrada.</Typography>}</Stack>}
            {tab === 4 && <Stack spacing={.75}>{(detail?.events ?? []).slice().reverse().map((event, index) => <Typography key={`${event.at}-${index}`} variant="body2">{new Date(event.at).toLocaleString("pt-BR")} · {eventLabel(event.type)}</Typography>)}{!detail?.events?.length && <Typography color="text.secondary">Nenhum histórico disponível.</Typography>}</Stack>}
          </Box>
        </Paper>
      </Box>
    )}

    {!isWideScreen && detailMinimized && selected && (
      <Button variant="contained" size="small" onClick={() => { setDetailMinimized(false); setDrawerOpen(true) }} aria-label="Reabrir detalhe da tarefa" sx={{ position: "fixed", bottom: 16, right: 16, zIndex: 1100 }} data-testid="btn-reopen-detail">
        <ExpandLessRounded sx={{ mr: 0.5 }} /> Abrir detalhe
      </Button>
    )}

  <Drawer anchor="right" open={drawerOpen && selectedId !== "" && !isWideScreen && !detailMinimized} onClose={() => setDrawerOpen(false)} data-testid="operation-task-drawer" PaperProps={{ sx: { width: { xs: "100%", sm: "40vw" }, maxWidth: 680 } }}>
    {selected && <Stack sx={{ height: "100%", overflow: "hidden" }}><Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ p: 2 }}><Box sx={{ minWidth: 0 }}><Typography variant="h6" noWrap>#{selected.id} {selected.titulo}</Typography><Stack direction="row" spacing={.75} sx={{ mt: .75 }} flexWrap="wrap" useFlexGap><Chip size="small" label={taskStatusLabel(status)} color={taskStatusColor(status)} />{selected.tipo && <Chip size="small" variant="outlined" label={selected.tipo} />}{status === "awaiting_clarification" && <Chip size="small" color="warning" label="Resposta necessária" />}{status === "blocked" && (detail?.task?.recoveryEligibility ?? selected.recoveryEligibility) && <Tooltip title={<RecoveryEligibilityTooltipContent eligibility={(detail?.task?.recoveryEligibility ?? selected.recoveryEligibility)!} />}><Chip size="small" color="warning" label={recoveryEligibilityLabel((detail?.task?.recoveryEligibility ?? selected.recoveryEligibility)!)} /></Tooltip>}</Stack></Box><Stack direction="row" spacing={0.5}><Tooltip title="Minimizar detalhe"><IconButton onClick={() => { setDrawerOpen(false); setDetailMinimized(true) }} aria-label="Minimizar detalhe"><ExpandMoreRounded /></IconButton></Tooltip><IconButton onClick={() => setDrawerOpen(false)} aria-label="Fechar detalhe"><CloseRounded /></IconButton></Stack></Stack><Divider />
      <Box sx={{ px: 2, py: 1.5, flexShrink: 0 }}>{renderHeaderActions()}</Box><Divider />
      <Tabs sx={{ px: 1, flexShrink: 0 }} value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" aria-label="Detalhes da tarefa"><Tab label="Resumo" /><Tab label="Chat" /><Tab label="Execução" /><Tab label="Logs" /><Tab label="Histórico" /></Tabs><Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        {tab === 0 && renderSummaryTab()}
        {tab === 1 && <Stack spacing={1.5}><Stack direction="row" spacing={.75} flexWrap="wrap" useFlexGap><Chip size="small" color={status === "awaiting_interaction" ? "warning" : "default"} label={status === "awaiting_interaction" ? "Aguardando você" : chatWaiting ? "Checkpoint pendente" : "Pronto para conversar"} />{status !== "awaiting_interaction" && <Typography variant="caption" color="text.secondary" sx={{ alignSelf: "center" }}>Mensagens durante a execução serão entregues no próximo checkpoint seguro.</Typography>}</Stack><Box data-testid="operation-chat-history" sx={{ minHeight: 160, maxHeight: "55vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 1, p: 1, bgcolor: "background.default", borderRadius: 1 }}>{chatLoading && <CircularProgress size={22} />}{chatError && <Alert severity="error">{chatError}</Alert>}{!chatLoading && !chat.length && !chatError && <Typography color="text.secondary" align="center">Nenhuma mensagem ainda.</Typography>}{chat.map(message => <Box key={message.id} sx={{ alignSelf: ["assistant", "agent", "analyst"].includes(message.role) ? "flex-start" : "flex-end", maxWidth: "90%", p: 1.25, borderRadius: 1.5, bgcolor: ["assistant", "agent", "analyst"].includes(message.role) ? "action.hover" : "primary.main", color: ["assistant", "agent", "analyst"].includes(message.role) ? "text.primary" : "primary.contrastText" }}><Typography variant="caption" display="block">{["assistant", "agent", "analyst"].includes(message.role) ? "Agente" : "Você"} · {new Date(message.createdAt).toLocaleString("pt-BR")}</Typography><Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message.texto}</Typography></Box>)}</Box>{chatWaiting && <Typography variant="caption" color="text.secondary">Mensagem aguardando resposta do agente…</Typography>}{realtime !== "open" && <Typography variant="caption" color="warning.main">Tempo real indisponível; tentando reconectar…</Typography>}<Stack direction="row" spacing={1} alignItems="flex-start"><TextField fullWidth multiline minRows={2} maxRows={5} placeholder="Conversar com o agente…" value={chatInput} disabled={chatSending} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendChat() } }} inputProps={{ "data-testid": "operation-chat-input", maxLength: 8000 }} helperText={`${chatInput.length}/8000 · Ctrl+Enter para enviar`} /><Stack spacing={.75}><Button variant="contained" disabled={!chatInput.trim() || chatSending} onClick={() => void sendChat()} startIcon={chatSending ? <CircularProgress size={16} /> : <SendRounded />}>Enviar</Button><Button size="small" variant="outlined" disabled={!chatInput.trim() || chatSending || status === "awaiting_interaction"} onClick={() => void sendChat("solicitar_pausa")} startIcon={<PauseRounded />}>Pausar e conversar</Button>{status === "awaiting_interaction" && <Button size="small" variant="outlined" disabled={chatSending} onClick={() => void resumeInteraction()} startIcon={<ReplayRounded />}>Retomar execução</Button>}</Stack></Stack></Stack>}
        {tab === 2 && <Stack spacing={1}>{subtasks.map(sub => <Paper key={sub.seq} variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="body2" fontWeight={600}>{sub.seq}. {sub.id != null ? `[#${sub.id}] ` : ""}{sub.title}</Typography>{sub.scope && <Typography variant="caption" color="text.secondary">{sub.scope}</Typography>}<Typography variant="caption" display="block" color="text.secondary">Critérios: {criteria(sub.acceptanceCriteria).length} · Entregas: {sub.deliverCount ?? 0}{sub.workspaceStatus ? ` · Workspace: ${sub.workspaceStatus}` : ""}</Typography></Box><Stack direction="row" spacing={.5} alignItems="center"><Chip size="small" label={taskStatusLabel(sub.status)} color={taskStatusColor(sub.status)} />{sub.deliveryHistory?.length ? <IconButton size="small" aria-label="Ver histórico de entregas" onClick={() => setExpandedHistory(old => { const next = new Set(old); if (next.has(sub.seq)) next.delete(sub.seq); else next.add(sub.seq); return next })}>{expandedHistory.has(sub.seq) ? <ExpandLessRounded /> : <ExpandMoreRounded />}</IconButton> : null}<IconButton size="small" aria-label={`Editar subtarefa ${sub.seq}`} onClick={() => { const db = dbSubtasks.find(item => item.seq === sub.seq); if (db) { setEditingSub(db); setEditSubError(null); setEditSubOpen(true) } }}><EditRounded /></IconButton><IconButton size="small" aria-label={`Visualizar sessão da subtarefa ${sub.seq}`} onClick={() => void openSessions(sub)}><VisibilityRounded /></IconButton></Stack></Stack>{renderSubtaskExecutionInfo(sub)}{expandedHistory.has(sub.seq) && sub.deliveryHistory?.map(h => <Typography key={h.id} variant="caption" display="block" sx={{ mt: .5 }}>{h.deliverNumber}. {eventLabel(h.eventType)} · {h.model ?? "—"} · {h.reason ?? "sem motivo"}</Typography>)}</Paper>)}{!subtasks.length && <Typography color="text.secondary">Nenhuma subtarefa disponível.</Typography>}</Stack>}
        {tab === 3 && <Stack spacing={.75}>{operations.map(operation => <Box key={`${operation.operationId}-${operation.sequence}`} sx={{ borderBottom: "1px dashed", borderColor: "divider", pb: .75 }}><Typography variant="caption" color="text.secondary">{new Date(operation.createdAt).toLocaleString("pt-BR")} · {operation.phase} / {operation.outcome}</Typography><Typography variant="body2">{operation.commandCode ?? operation.messageType}{operation.actionCode ? ` → ${operation.actionCode}` : ""}{operation.primitiveCode ? ` → ${operation.primitiveCode}` : ""}</Typography>{operation.policyCode && <Typography variant="caption" display="block">Política: {operation.policyCode} v{operation.policyVersion ?? 1}</Typography>}{operation.reasonCode && <Typography variant="caption" display="block" color="warning.main">Motivo: {operation.reasonCode}</Typography>}{operation.resultJson && <Typography variant="caption" display="block" color="text.secondary">{JSON.stringify(operation.resultJson).slice(0, 300)}</Typography>}</Box>)}{!operations.length && <Typography color="text.secondary">Nenhuma operação do Motor v3 registrada.</Typography>}</Stack>}
        {tab === 4 && <Stack spacing={.75}>{(detail?.events ?? []).slice().reverse().map((event, index) => <Typography key={`${event.at}-${index}`} variant="body2">{new Date(event.at).toLocaleString("pt-BR")} · {eventLabel(event.type)}</Typography>)}{!detail?.events?.length && <Typography color="text.secondary">Nenhum histórico disponível.</Typography>}</Stack>}
      </Box></Stack>}
  </Drawer>

  <Dialog open={newTaskOpen} onClose={() => !newTaskLoading && setNewTaskOpen(false)} fullWidth maxWidth="md"><DialogTitle>Nova tarefa</DialogTitle><DialogContent><TarefaForm projetos={projects} loading={newTaskLoading} error={newTaskError} onSubmit={createTask} /></DialogContent></Dialog>
  <Dialog open={editOpen} onClose={() => !editLoading && setEditOpen(false)} fullWidth maxWidth="md"><DialogTitle>Editar tarefa</DialogTitle><DialogContent>{editError && <Alert severity="error">{editError}</Alert>}{selected && <DynamicForm key={selected.id} fields={editFields} initialValues={{ titulo: selected.titulo, descricao: selected.descricao ?? "", tipo: selected.tipo ?? "desenvolvimento", dependsOnTaskId: selected.dependsOnTaskId ?? "" }} loading={editLoading} actionState="update" submitLabel="Salvar alterações" onSubmit={editTask} onCancel={() => setEditOpen(false)} />}</DialogContent></Dialog>
  <Dialog open={sessionOpen} onClose={() => !sessionLoading && setSessionOpen(false)} fullWidth maxWidth="lg"><DialogTitle>{sessionTitle}</DialogTitle><DialogContent>{sessionLoading && <CircularProgress size={22} />}{sessionError && <Alert severity="error">{sessionError}</Alert>}{!sessionLoading && !sessionError && !sessions.length && <Typography color="text.secondary">Nenhuma sessão disponível.</Typography>}{sessions.map((session, index) => <Paper key={session.sessionKey} variant="outlined" sx={{ p: 1.5, mb: 1.5 }}><Stack direction="row" spacing={1} alignItems="center"><Typography fontWeight={700}>{session.model ?? `Sessão ${index + 1}`}</Typography>{session.status && <Chip size="small" label={session.status} />}</Stack><Box component="pre" onScroll={event => handleSessionScroll(event, session)} sx={{ whiteSpace: "pre-wrap", maxHeight: "45vh", overflow: "auto", bgcolor: "action.hover", p: 1 }}>{session.messages.items.slice().sort((a, b) => b.sequenceNumber - a.sequenceNumber).map(m => `[${m.role}]\n${m.text}\n`).join("\n")}</Box>{sessionPageErrors[session.sessionKey] && <Alert severity="error" sx={{ mt: 1 }}>{sessionPageErrors[session.sessionKey]}</Alert>}{sessionPageLoading.has(session.sessionKey) && <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}><CircularProgress size={16} /><Typography variant="caption">Carregando mensagens…</Typography></Stack>}</Paper>)}</DialogContent></Dialog>
  <Dialog open={editSubOpen} onClose={() => !editSubLoading && setEditSubOpen(false)} fullWidth maxWidth="md"><DialogTitle>Editar subtarefa</DialogTitle><DialogContent>{editSubError && <Alert severity="error">{editSubError}</Alert>}{editingSub && <DynamicForm key={editingSub.id} fields={editSubFields} initialValues={{ titulo: editingSub.titulo, status: editingSub.status, seq: editingSub.seq, scope: editingSub.scope ?? "", acceptance_criteria: criteria(editingSub.acceptanceCriteria).join("\n"), resultado: editingSub.resultado ?? "", dependsOnSubtaskId: editingSub.dependsOnSubtaskId ?? "" }} loading={editSubLoading} actionState="update" submitLabel="Salvar alterações" onSubmit={saveSubtask} onCancel={() => setEditSubOpen(false)} />}</DialogContent></Dialog>

  {/* TaskCodeViewer — modal fullscreen dentro do espaço livre */}
  {selected && (
    <TaskCodeViewer
      taskId={selected.id}
      taskTitle={selected.titulo}
      hasIntegrationBranch={detail?.exists ?? false}
      open={codeViewerOpen}
      onClose={() => setCodeViewerOpen(false)}
      persistedConflictData={detail?.task?.promotionConflictAnalysis ?? null}
    />
  )}
  </Box>
}
