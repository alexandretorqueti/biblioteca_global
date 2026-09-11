/**
 * TaskMonitorScreen — acompanhamento em TEMPO REAL da execução de tarefas
 * no motor GerenteAgentes (reproduz o dashboard-standalone.html do motor
 * dentro da biblioteca).
 *
 * - Carga inicial HTTP e atualizações posteriores pelo WebSocket realtime
 * - Subtarefas com status, progresso (verified/total), banner da subtarefa atual
 * - Activity feed com os eventos do motor
 * - Ações: iniciar / pausar / retomar
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material"
import { useTheme } from "@mui/material/styles"
import { PlayArrowRounded, PauseRounded, ReplayRounded, LockOpenRounded, EditRounded, CloseRounded, ExpandMoreRounded, ExpandLessRounded, AddTaskRounded, SendRounded, VisibilityRounded, PsychologyRounded } from "@mui/icons-material"
import { DynamicForm } from "@biblioteca-global/ui"
import { RealtimeClient, type RealtimeServerMessage } from "@biblioteca-global/api-client"
import type { DynamicField, DynamicFormValues } from "@biblioteca-global/ui"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import TarefaForm, { type TarefaFormValues } from "./TarefaForm"
import TaskFlowMap, { type MotorActivity, type FiltrosMapa } from "./TaskFlowMap"
import { resolveRealtimeUrl, resolveApiBaseUrl } from "../../../apps/web/src/api/client"
import {
  ALL_TASK_STATUSES,
  TASK_STATUS_FINAIS as _TASK_STATUS_FINAIS,
  TASK_STATUS_STARTABLE as _TASK_STATUS_STARTABLE,
  TASK_STATUS_EXECUTING as _TASK_STATUS_EXECUTING,
  TASK_STATUS_OPTIONS,
  SUBTASK_STATUS_OPTIONS,
  taskStatusColor,
  taskStatusLabel,
} from "../motor-v2/src/shared/task-statuses"

export const componentId = "gerenteagentes-task-monitor"

interface Tarefa {
  id: number
  externalId?: string | null
  titulo: string
  descricao?: string | null
  tipo?: "desenvolvimento" | "automacao" | "verificacao" | string | null
  dependsOnTaskId?: number | null
  status: string
  projetoId: number
  updatedAt?: string
  createdAt?: string
  subtaskCount?: number
}

interface TarefaChatMessage {
  id: number
  tarefaId: number
  role: string
  texto: string
  createdAt: string | Date
}

const TIPO_TAREFA_LABEL: Record<string, string> = {
  desenvolvimento: "Desenvolvimento",
  automacao: "Automação",
  verificacao: "Verificação",
}

interface ProjetoCaptado {
  id: number
  nome: string
}

/** Status conhecidos — fonte única em ../motor-v2/src/shared/task-statuses */

interface DeliveryHistoryEntry {
  id: number
  deliverNumber: number
  model: string | null
  eventType: "delivery_started" | "gate_rejected" | "return_for_rework" | "blocked" | "completed"
  reason: string | null
  createdAt: string
}

interface SubTaskMotor {
  seq: number
  title: string
  status: string
  deliverCount?: number
  blockInfo?: { reason?: string; command?: string; exitCode?: number | null } | null
  scope?: string | null
  acceptanceCriteria?: unknown
  workspaceStatus?: string | null
  correctionForSubtaskId?: number | null
  deliveryHistory?: DeliveryHistoryEntry[]
}

/** Subtarefa do banco de dados (para edição — o motor só tem seq/title/status). */
interface SubTarefaDb {
  id: number
  tarefaId: number
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

interface SessionMessage {
  role: "agent" | "user" | "system"
  text: string
}

interface SubtaskSession {
  available: boolean
  sessionKey?: string
  text: string
  messages: SessionMessage[]
}

interface AnalystSessionMessage {
  role: string
  text: string
  sequenceNumber: number
}

interface AnalystSessionEntry {
  executionOrder: number
  model: string
  sessionKey: string
  status: string
  openedAt: string
  closedAt: string | null
  closeReason: string | null
  messages: AnalystSessionMessage[]
  text: string
}

interface AnalystTaskSessionsResponse {
  available: boolean
  sessions: AnalystSessionEntry[]
}

interface MotorEvent {
  at: string
  type: string
  payload?: Record<string, unknown>
}

interface MotorDetail {
  motorId: string
  exists: boolean
  message?: string
  task?: {
    id: string
    status: string
    title: string
    errorMessage?: string
    blockInfo?: {
      kind?: string
      excerpt?: string
      blockedAt?: string
      subtaskId?: number | null
    } | null
    promotionConflictAnalysis?: {
      status: string
      confidence: string | null
      recommendation: string | null
      report: string | null
      errorMessage: string | null
      conflictFiles: string[]
      attempts: number
      updatedAt: string
    } | null
  }
  subtasks?: SubTaskMotor[]
  currentSubTask?: SubTaskMotor | null
  events?: MotorEvent[]
  errors?: Array<{ subtaskId?: string; ok?: boolean; failures?: string }>
  models?: Array<{ model: string; tierIndex?: number; reason?: string; occurredAt?: string }>
}


interface MotorStats {
  activities?: MotorActivity[]
}

const STATUS_FINAIS = _TASK_STATUS_FINAIS
const STATUS_INICIO_PERMITIDO = _TASK_STATUS_STARTABLE
const STATUS_EXECUCAO = _TASK_STATUS_EXECUTING

function corStatus(status: string): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" {
  return taskStatusColor(status)
}

function traduzirEvento(type: string): string {
  const mapa: Record<string, string> = {
    task_queued: "Enfileirada",
    task_started: "Iniciada",
    task_planned: "Planejada",
    task_blocked_baseline: "Bloqueada na triagem (baseline)",
    task_completed: "Concluída",
    task_finalizada: "Finalizada",
    task_deployada: "Deployada",
    task_paused: "Pausada",
    task_resumed: "Retomada",
    subtask_created: "Subtarefa criada",
    subtask_planned: "Subtarefa planejada",
    subtask_started: "Subtarefa iniciada",
    subtask_delivered: "Subtarefa entregue",
    subtask_verifying: "Verificando",
    subtask_verified: "Subtarefa verificada",
    subtask_rejected: "Subtarefa rejeitada",
    subtask_blocked: "Subtarefa bloqueada",
    model_escalated: "Modelo escalado",
    motor_fix: "Correção do motor",
  }
  return mapa[type] ?? type
}

/**
 * Conta critérios de aceite com segurança: aceita array de strings,
 * string JSON válida com array, ou retorna 0 para null/undefined/inválido.
 */
function contarCriterios(raw: unknown): number {
  if (raw == null) return 0
  if (Array.isArray(raw)) return raw.length
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.length : 0
    } catch {
      return 0
    }
  }
  return 0
}

/**
 * ST-3: converte o valor bruto de acceptance_criteria (array, string JSON ou null)
 * em um array de strings utilizável no formulário e no payload.
 */
function parseCriterios(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string")
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string")
    } catch {
      // não é JSON válido — tratar como texto simples de uma linha
      return raw.trim() ? [raw.trim()] : []
    }
  }
  return []
}

/**
 * ST-3: converte o texto do textarea (um critério por linha) em array de strings.
 * Linhas vazias ou só com espaços são descartadas.
 */
function parseCriteriosTexto(texto: string): string[] {
  if (!texto || !texto.trim()) return []
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
}

export default function TaskMonitorScreen(): ReactNode {
  const bundle = useApi()
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"))
  // 6.1 — Bottom sheet para detalhe da tarefa em mobile
  const [bottomSheetOpen, setBottomSheetOpen] = useState(false)
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [projetos, setProjetos] = useState<ProjetoCaptado[]>([])
  const [projetoFiltro, setProjetoFiltro] = useState<number | "">("")
  const [statusFiltro, setStatusFiltro] = useState<string>("")
  const [buscaTarefa, setBuscaTarefa] = useState("")
  const [motorActivities, setMotorActivities] = useState<MotorActivity[]>([])
  // Filtros integrados ao mapa (substituem a combo de tarefas)
  const [filtrosMapa, setFiltrosMapa] = useState<FiltrosMapa>({
    busca: "",
    status: [],
    projetoId: "",
    prioridade: "",
  })
  const [tarefaId, setTarefaId] = useState<number | "">("")
  const [detail, setDetail] = useState<MotorDetail | null>(null)
  const [chat, setChat] = useState<TarefaChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [chatSending, setChatSending] = useState(false)
  const [chatWaitingResponse, setChatWaitingResponse] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const chatRequestId = useRef(0)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [acao, setAcao] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskLoading, setNewTaskLoading] = useState(false)
  const [newTaskError, setNewTaskError] = useState<string | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // ST-2: edição de subtarefa
  const [subtarefasDb, setSubtarefasDb] = useState<SubTarefaDb[]>([])
  const [editSubOpen, setEditSubOpen] = useState(false)
  const [editSubLoading, setEditSubLoading] = useState(false)
  const [editSubError, setEditSubError] = useState<string | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "open" | "closed">("closed")
  const [terminalEvents, setTerminalEvents] = useState<RealtimeServerMessage[]>([])
  const [editingSub, setEditingSub] = useState<SubTarefaDb | null>(null)
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<number>>(new Set())
  const [sessionOpen, setSessionOpen] = useState(false)
  const [sessionSubtask, setSessionSubtask] = useState<SubTaskMotor | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SubtaskSession | null>(null)
  const [pausandoTodas, setPausandoTodas] = useState(false)
  const [retomandoTodas, setRetomandoTodas] = useState(false)
  const [bulkMessage, setBulkMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [analystSessionOpen, setAnalystSessionOpen] = useState(false)
  const [analystSessionLoading, setAnalystSessionLoading] = useState(false)
  const [analystSessionError, setAnalystSessionError] = useState<string | null>(null)
  const [analystSessionData, setAnalystSessionData] = useState<AnalystTaskSessionsResponse | null>(null)
  const mounted = useRef(true)
  const activeRealtimeTask = useRef<number | "">("")

  const carregarProjetos = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<{ items: ProjetoCaptado[] }>(
        "GET",
        "/gerenteagentes/projetos_captados",
        { query: { pageSize: 100 }, auth: "access" },
      )
      setProjetos(res.items ?? [])
    } catch {
      // silencioso — a combo de projeto fica vazia até a próxima tentativa
    }
  }, [bundle])

  const carregarTarefas = useCallback(async () => {
    if (!bundle) return
    try {
      const query: Record<string, string | number> = { pageSize: 100 }
      if (projetoFiltro !== "") query.projetoId = projetoFiltro
      if (statusFiltro !== "") query.status = statusFiltro
      // Usa o endpoint que retorna status calculado pelo motor (fatos operacionais)
      // em vez do CRUD genérico que retorna o status gravado no banco.
      const res = await bundle.http.request<Tarefa[]>("GET", "/gerenteagentes/tarefas-com-status", {
        query,
        auth: "access",
      })
      const lista = (res ?? []).sort((a, b) =>
        new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
      )
      setTarefas(lista)
      setTarefaId((atual) => {
        if (atual !== "") {
          const aindaExiste = lista.some((t) => t.id === atual)
          if (aindaExiste) return atual
        }
        const emExecucao = lista.find((t) => !STATUS_FINAIS.has(t.status) && t.status !== "draft")
        return emExecucao?.id ?? lista[0]?.id ?? ""
      })
    } catch {
      // silencioso — o painel fica vazio até a próxima tentativa
    }
  }, [bundle, projetoFiltro, statusFiltro])

  const carregarDetail = useCallback(async (id: number) => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<MotorDetail>("GET", `/gerenteagentes/tarefas/${id}/motor-detail`, {
        auth: "access",
      })
      if (mounted.current) setDetail(res)
    } catch (e) {
      if (mounted.current) setErro(e instanceof Error ? e.message : "Erro ao carregar detalhes da tarefa")
    }
  }, [bundle])


  const carregarAtividadeMotor = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<MotorStats>("GET", "/gerenteagentes/motor-activity", { auth: "access" })
      if (mounted.current) setMotorActivities(res.activities ?? [])
    } catch {
      // Atividade é complementar; não interrompe o acompanhamento se o Motor reiniciar.
    }
  }, [bundle])

  const carregarChat = useCallback(async (id: number) => {
    if (!bundle) return
    const requestId = ++chatRequestId.current
    setChatError(null)
    setChatLoading(true)
    try {
      const res = await bundle.http.request<TarefaChatMessage[] | { items?: TarefaChatMessage[] }>(
        "GET", `/gerenteagentes/tarefas/${id}/chat`, { auth: "access" },
      )
      if (mounted.current && requestId === chatRequestId.current) {
        const historico = Array.isArray(res) ? res : (res.items ?? [])
        // Não perder uma mensagem recebida enquanto o GET estava em voo.
        setChat((atual) => {
          const porId = new Map(historico.map((mensagem) => [mensagem.id, mensagem]))
          for (const mensagem of atual) {
            if (!porId.has(mensagem.id)) porId.set(mensagem.id, mensagem)
          }
          return [...porId.values()].sort((a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
        })
        const ultima = historico.at(-1)
        if (ultima && (ultima.role === "assistant" || ultima.role === "agent" || ultima.role === "analyst")) {
          setChatWaitingResponse(false)
        }
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

  const enviarMensagemChat = useCallback(async () => {
    const texto = chatInput.trim()
    if (!bundle || tarefaId === "" || !texto || chatSending) return

    const tarefaAtual = tarefaId
    setChatSending(true)
    setChatWaitingResponse(true)
    setChatError(null)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${tarefaAtual}/chat`, {
        body: { role: "user", texto },
        auth: "access",
      })
      // Só limpa o campo se a tarefa ainda for a mesma; assim uma troca de
      // tarefa durante a chamada não apaga o rascunho da nova conversa.
      if (tarefaId === tarefaAtual) {
        setChatInput("")
        // A resposta do agente chega pelo WebSocket. A recarga continua como
        // fallback para APIs antigas que ainda não emitem o evento de chat.
        await carregarChat(tarefaAtual)
      }
    } catch (e) {
      if (tarefaId === tarefaAtual) {
        setChatWaitingResponse(false)
        setChatError(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.")
      }
    } finally {
      setChatSending(false)
    }
  }, [bundle, tarefaId, chatInput, chatSending, carregarChat])

  /** ST-2: carrega subtarefas do banco para ter IDs ao editar. */
  const carregarSubtarefasDb = useCallback(async (id: number) => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<SubTarefaDb[]>(
        "GET",
        `/gerenteagentes/tarefas/${id}/subtarefas`,
        { auth: "access" },
      )
      if (mounted.current) setSubtarefasDb(Array.isArray(res) ? res : [])
    } catch {
      if (mounted.current) setSubtarefasDb([])
    }
  }, [bundle])

  const desbloquearTarefa = useCallback(async () => {
    if (!bundle || tarefaId === "") return
    setAcao("unlock")
    setErro(null)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${tarefaId}/unlock`, {
        auth: "access",
      })
      await carregarDetail(tarefaId)
      await carregarSubtarefasDb(tarefaId)
      await carregarTarefas()
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao desbloquear tarefa")
    } finally {
      setAcao(null)
    }
  }, [bundle, tarefaId, carregarDetail, carregarSubtarefasDb, carregarTarefas])

  useEffect(() => {
    mounted.current = true
    void carregarProjetos()
    void carregarTarefas()
    void carregarAtividadeMotor()
    
    // Polling periódico para atualizar a lista de tarefas (TaskFlowMap)
    // O WebSocket está conectado apenas para a tarefa selecionada,
    // então precisamos recarregar todas as tarefas periodicamente.
    const intervalId = setInterval(() => {
      void carregarTarefas()
      void carregarAtividadeMotor()
      // Atualiza também os detalhes da tarefa selecionada
      if (tarefaId !== "") {
        void carregarDetail(tarefaId)
        void carregarSubtarefasDb(tarefaId)
        void carregarChat(tarefaId)
      }
    }, 5000) // 5 segundos
    
    return () => {
      mounted.current = false
      clearInterval(intervalId)
    }
  }, [carregarProjetos, carregarTarefas, carregarAtividadeMotor, tarefaId, carregarDetail, carregarSubtarefasDb, carregarChat])

  useEffect(() => {
    if (tarefaId === "") {
      activeRealtimeTask.current = ""
      setRealtimeStatus("closed")
      setDetail(null)
      setChat([])
      setChatInput("")
      setChatError(null)
      setChatLoading(false)
      setChatWaitingResponse(false)
      return
    }
    setDetail(null)
    setChat([])
    setChatInput("")
    setChatError(null)
    setChatLoading(true)
    setChatWaitingResponse(false)
    void carregarDetail(tarefaId)
    void carregarSubtarefasDb(tarefaId)
    void carregarChat(tarefaId)
  }, [tarefaId, carregarDetail, carregarSubtarefasDb, carregarChat])

  const aplicarEventoTarefa = useCallback((type: string, payload: Record<string, unknown>, eventTaskId: number) => {
    if (type === "task.deleted") {
      setTarefas((atual) => atual.filter((tarefa) => tarefa.id !== eventTaskId))
      setTarefaId((atual) => atual === eventTaskId ? "" : atual)
      return
    }
    if (type === "task.status.changed") {
      const status = typeof payload.status === "string" ? payload.status : null
      if (!status) return
      setTarefas((atual) => atual.map((tarefa) => tarefa.id === eventTaskId ? { ...tarefa, status } : tarefa))
      setDetail((atual) => atual?.task && eventTaskId === tarefaId
        ? { ...atual, task: { ...atual.task, status } }
        : atual)
      return
    }
    if (type !== "task.created" && type !== "task.updated") return
    const tarefa: Tarefa = {
      id: Number(payload.id ?? eventTaskId),
      titulo: String(payload.titulo ?? payload.title ?? ""),
      descricao: typeof payload.descricao === "string" ? payload.descricao : null,
      tipo: typeof payload.tipo === "string" ? payload.tipo : null,
      dependsOnTaskId: typeof payload.dependsOnTaskId === "number" ? payload.dependsOnTaskId : null,
      status: String(payload.status ?? "draft"),
      projetoId: Number(payload.projetoId ?? payload.projectId ?? 0),
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : undefined,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : undefined,
    }
    setTarefas((atual) => {
      const index = atual.findIndex((item) => item.id === tarefa.id)
      if (index < 0) return [tarefa, ...atual]
      const anterior = atual[index]
      if (!anterior) return atual
      const proxima = [...atual]
      proxima[index] = {
        ...anterior,
        ...tarefa,
        ...(payload.descricao === undefined ? { descricao: anterior.descricao } : {}),
        ...(payload.tipo === undefined ? { tipo: anterior.tipo } : {}),
        ...(payload.dependsOnTaskId === undefined ? { dependsOnTaskId: anterior.dependsOnTaskId } : {}),
        ...(payload.createdAt === undefined ? { createdAt: anterior.createdAt } : {}),
      }
      return proxima.sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime())
    })
    if (eventTaskId === tarefaId) {
      setDetail((atual) => atual?.task ? { ...atual, task: { ...atual.task, title: tarefa.titulo, status: tarefa.status } } : atual)
    }
  }, [tarefaId])

  useEffect(() => {
    if (tarefaId === "" || !bundle) return
    activeRealtimeTask.current = tarefaId
    setTerminalEvents([])
    const realtime = new RealtimeClient({
      url: resolveRealtimeUrl(),
      baseUrl: resolveApiBaseUrl(),
      taskId: tarefaId,
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: (status) => {
        if (activeRealtimeTask.current === tarefaId) setRealtimeStatus(status)
      },
      onMessage: (message) => {
        // O socket anterior pode entregar um evento já enfileirado depois da
        // troca de tarefa. Nunca deixe esse evento contaminar a conversa nova.
        if (activeRealtimeTask.current !== tarefaId) return
        if (message.type === "replay_unavailable") {
          // O buffer do servidor expirou; recupera a fonte persistida antes de
          // continuar ouvindo a conexão recém-reaberta.
          void carregarDetail(tarefaId)
          void carregarSubtarefasDb(tarefaId)
          void carregarChat(tarefaId)
          return
        }
        if (message.type === "error") {
          setChatError(message.message)
          return
        }
        if (message.type !== "event") return
        setTerminalEvents((atual) => [...atual, message].slice(-500))
        if (message.event.type.includes("chat")) {
          const payload = message.event.payload
          const id = Number(payload.id)
          const texto = typeof payload.texto === "string" ? payload.texto : null
          const role = typeof payload.role === "string" ? payload.role : null
          if (id > 0 && texto && role) {
            setChat((atual) => {
              if (atual.some((item) => item.id === id)) return atual
              return [...atual, {
                id,
                tarefaId,
                role,
                texto,
                createdAt: typeof payload.createdAt === "string" ? payload.createdAt : message.event.occurredAt,
              }].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            })
            if (role === "assistant" || role === "agent" || role === "analyst") setChatWaitingResponse(false)
          } else {
            void carregarChat(tarefaId)
          }
        }
        if (message.event.type === "task.status.changed") {
          aplicarEventoTarefa(message.event.type, message.event.payload, message.event.taskId)
        }
        if (message.event.type === "task.created" || message.event.type === "task.updated" || message.event.type === "task.deleted") {
          aplicarEventoTarefa(message.event.type, message.event.payload, message.event.taskId)
        }
        if (message.event.type.startsWith("subtask.")) {
          // O protocolo de subtarefa não carrega todos os campos do detalhe;
          // reconcilia o snapshot somente após o evento, sem polling.
          void carregarDetail(tarefaId)
          void carregarSubtarefasDb(tarefaId)
        }
      },
    })
    void realtime.connect()
    return () => {
      if (activeRealtimeTask.current === tarefaId) activeRealtimeTask.current = ""
      realtime.close()
    }
  }, [tarefaId, bundle, carregarChat, carregarDetail, carregarSubtarefasDb, aplicarEventoTarefa])

  useEffect(() => {
    setLoading(false)
  }, [])

  const executarAcao = useCallback(
    async (acaoNome: "start" | "pause" | "resume") => {
      if (!bundle || tarefaId === "") return
      setAcao(acaoNome)
      setErro(null)
      try {
        await bundle.http.request("POST", `/gerenteagentes/tarefas/${tarefaId}/${acaoNome}`, {
          auth: "access",
        })
        await carregarDetail(tarefaId)
        await carregarTarefas()
      } catch (e) {
        setErro(e instanceof Error ? e.message : `Erro ao ${acaoNome === "start" ? "iniciar" : acaoNome === "pause" ? "pausar" : "retomar"} tarefa`)
      } finally {
        setAcao(null)
      }
    },
    [bundle, tarefaId, carregarDetail, carregarTarefas],
  )

  const executarAcaoBulk = useCallback(
    async (acaoNome: 'pause-all' | 'resume-all') => {
      if (!bundle) return
      const setLoading = acaoNome === 'pause-all' ? setPausandoTodas : setRetomandoTodas
      setLoading(true)
      setBulkMessage(null)
      try {
        const res = await bundle.http.request<{ affected?: number }>("POST", `/gerenteagentes/tarefas/${acaoNome}`, {
          auth: "access",
        })
        const contagem = typeof res?.affected === 'number' ? res.affected : undefined
        const label = acaoNome === 'pause-all' ? 'pausadas' : 'retomadas'
        setBulkMessage({
          type: 'success',
          text: contagem !== undefined
            ? `${contagem} tarefa${contagem === 1 ? '' : 's'} ${label} com sucesso.`
            : `Ação '${acaoNome === 'pause-all' ? 'Pausar todas' : 'Retomar todas'}' executada.`,
        })
        await carregarTarefas()
      } catch (e) {
        setBulkMessage({
          type: 'error',
          text: e instanceof Error ? e.message : `Erro ao executar ${acaoNome === 'pause-all' ? 'pausar todas' : 'retomar todas'}`,
        })
      } finally {
        setLoading(false)
      }
    },
    [bundle, carregarTarefas],
  )

  const iniciarTarefaId = useCallback(
    async (id: number) => {
      if (!bundle) return
      setErro(null)
      try {
        await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/start`, { auth: "access" })
        await carregarTarefas()
      } catch (e) {
        setErro(e instanceof Error ? e.message : "Erro ao iniciar tarefa")
      }
    },
    [bundle, carregarTarefas],
  )

  const pausarTarefaId = useCallback(
    async (id: number) => {
      if (!bundle) return
      setErro(null)
      try {
        await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/pause`, { auth: "access" })
        await carregarTarefas()
      } catch (e) {
        setErro(e instanceof Error ? e.message : "Erro ao pausar tarefa")
      }
    },
    [bundle, carregarTarefas],
  )

  const retomarTarefaId = useCallback(
    async (id: number) => {
      if (!bundle) return
      setErro(null)
      try {
        await bundle.http.request("POST", `/gerenteagentes/tarefas/${id}/resume`, { auth: "access" })
        await carregarTarefas()
      } catch (e) {
        setErro(e instanceof Error ? e.message : "Erro ao retomar tarefa")
      }
    },
    [bundle, carregarTarefas],
  )


  const handleNewTaskSubmit = useCallback(async (values: TarefaFormValues) => {
    if (!bundle) return
    setNewTaskLoading(true)
    setNewTaskError(null)
    try {
      await bundle.http.request("POST", "/gerenteagentes/tarefas", {
        body: {
          projeto_id: Number(values.projetoId),
          titulo: values.titulo,
          descricao: values.descricao || null,
          tipo: values.tipo,
        },
        auth: "access",
      })
      setNewTaskOpen(false)
    } catch (e) {
      setNewTaskError(e instanceof Error ? e.message : "Erro ao criar tarefa")
      throw e
    } finally {
      setNewTaskLoading(false)
    }
  }, [bundle])

  const getLoadOptions = useCallback(
    (resource: string) => async (search: string) => {
      if (!bundle) return []
      try {
        const res = await bundle.http.request<{ items: Array<Record<string, unknown>> }>(
          "GET",
          `/${resource}`,
          {
            query: search ? { search, pageSize: 50 } : { pageSize: 100 },
            auth: "access",
          },
        )
        return res.items ?? []
      } catch {
        return []
      }
    },
    [bundle],
  )

  const editFields: DynamicField[] = useMemo(
    () => [
      {
        name: "titulo",
        label: "Título",
        type: "text",
        required: true,
        maxLength: 200,
        fullWidth: true,
      },
      {
        name: "descricao",
        label: "Descrição",
        type: "textarea",
        fullWidth: true,
      },
      {
        name: "tipo",
        label: "Tipo de tarefa",
        type: "select",
        options: [
          { value: "desenvolvimento", label: "Desenvolvimento" },
          { value: "automacao", label: "Automação" },
          { value: "verificacao", label: "Verificação" },
        ],
      },
      {
        name: "status",
        label: "Status",
        type: "select",
        options: TASK_STATUS_OPTIONS,
      },
      {
        name: "dependsOnTaskId",
        label: "Depende da tarefa",
        type: "multipleChoice",
        multipleChoice: {
          resource: "tarefas",
          idField: "id",
          displayField: "titulo",
          loadOptions: getLoadOptions("tarefas"),
        },
      },
    ],
    [getLoadOptions],
  )

  const handleEditSubmit = useCallback(
    async (values: DynamicFormValues) => {
      if (!bundle || tarefaId === "") return
      setEditLoading(true)
      setEditError(null)
      try {
        const body: Record<string, unknown> = {
          titulo: String(values.titulo ?? "").trim(),
          descricao: values.descricao ? String(values.descricao).trim() : null,
          tipo: values.tipo ? String(values.tipo) : "desenvolvimento",
          status: values.status ? String(values.status) : undefined,
          dependsOnTaskId:
            values.dependsOnTaskId !== "" && values.dependsOnTaskId != null
              ? Number(values.dependsOnTaskId)
              : null,
        }
        await bundle.http.request("PUT", `/gerenteagentes/tarefas/${tarefaId}`, {
          body,
          auth: "access",
        })
        setEditOpen(false)
        await carregarDetail(tarefaId)
        await carregarTarefas()
      } catch (e) {
        setEditError(e instanceof Error ? e.message : "Erro ao atualizar tarefa")
      } finally {
        setEditLoading(false)
      }
    },
    [bundle, tarefaId, carregarDetail, carregarTarefas],
  )

  // ST-2: campos e handler do diálogo de edição de subtarefa
  // ST-3: descricao removida (coluna legada); scope + acceptance_criteria são os campos canônicos do motor-v2.
  // Status expandido para os 9 valores reais do sistema.
  const editSubFields: DynamicField[] = useMemo(
    () => [
      { name: "titulo", label: "Título", type: "text", required: true, maxLength: 200, fullWidth: true },
      {
        name: "status",
        label: "Status",
        type: "select",
        options: SUBTASK_STATUS_OPTIONS,
      },
      { name: "seq", label: "Ordem", type: "number", min: 0 },
      { name: "scope", label: "Escopo", type: "textarea", fullWidth: true, required: true },
      {
        name: "acceptance_criteria",
        label: "Critérios de aceite (um por linha)",
        type: "textarea",
        fullWidth: true,
        helperText: "Cada linha não vazia será enviada como um critério. Deixe vazio para nenhum critério.",
      },
      { name: "resultado", label: "Resultado", type: "textarea", fullWidth: true },
      {
        name: "dependsOnSubtaskId",
        label: "Depende da subtarefa",
        type: "multipleChoice",
        multipleChoice: {
          resource: "subtarefas",
          idField: "id",
          displayField: "titulo",
          loadOptions: getLoadOptions("subtarefas"),
        },
      },
    ],
    [getLoadOptions],
  )

  const editSubInitialValues = useMemo<DynamicFormValues>(() => {
    if (!editingSub) {
      return {
        titulo: "",
        status: "pending",
        seq: 0,
        scope: "",
        acceptance_criteria: "",
        resultado: "",
        dependsOnSubtaskId: "",
      }
    }
    const criterios = parseCriterios(editingSub.acceptanceCriteria)
    return {
      titulo: editingSub.titulo,
      status: editingSub.status,
      seq: editingSub.seq,
      scope: editingSub.scope ?? "",
      acceptance_criteria: criterios.join("\n"),
      resultado: editingSub.resultado ?? "",
      dependsOnSubtaskId: editingSub.dependsOnSubtaskId ?? "",
    }
  }, [editingSub])

  const handleEditSubSubmit = useCallback(
    async (values: DynamicFormValues) => {
      if (!bundle || !editingSub) return
      setEditSubLoading(true)
      setEditSubError(null)
      try {
        // ST-3: converter linhas do textarea em array JSON de strings
        const criteriosRaw = String(values.acceptance_criteria ?? "")
        const criteriosArray = parseCriteriosTexto(criteriosRaw)

        // Validação de tamanho razoável (max 50 critérios, 500 chars cada)
        if (criteriosArray.length > 50) {
          setEditSubError("Limite máximo de 50 critérios de aceite excedido.")
          setEditSubLoading(false)
          return
        }
        for (const c of criteriosArray) {
          if (c.length > 500) {
            setEditSubError("Cada critério de aceite pode ter no máximo 500 caracteres.")
            setEditSubLoading(false)
            return
          }
        }

        const scopeValor = String(values.scope ?? "").trim()
        if (!scopeValor) {
          setEditSubError("O escopo é obrigatório.")
          setEditSubLoading(false)
          return
        }

        // ST-3: descricao omitida do payload (coluna legada, não usada pelo motor-v2)
        const body: Record<string, unknown> = {
          titulo: String(values.titulo ?? "").trim(),
          status: String(values.status ?? "pending"),
          seq: Number(values.seq ?? 0),
          scope: scopeValor,
          acceptance_criteria: criteriosArray.length > 0 ? criteriosArray : null,
          resultado: values.resultado ? String(values.resultado).trim() : null,
          dependsOnSubtaskId:
            values.dependsOnSubtaskId !== "" && values.dependsOnSubtaskId != null
              ? Number(values.dependsOnSubtaskId)
              : null,
        }
        await bundle.http.request("PUT", `/gerenteagentes/subtarefas/${editingSub.id}`, {
          body,
          auth: "access",
        })
        setEditSubOpen(false)
        setEditingSub(null)
        if (tarefaId !== "") {
          await carregarDetail(tarefaId)
          await carregarSubtarefasDb(tarefaId)
        }
      } catch (e) {
        setEditSubError(e instanceof Error ? e.message : "Erro ao atualizar subtarefa")
      } finally {
        setEditSubLoading(false)
      }
    },
    [bundle, editingSub, tarefaId, carregarDetail, carregarSubtarefasDb],
  )

  /** Toggle da expansão do histórico de entregas de uma subtarefa. */
  const toggleSubtaskHistory = useCallback((seq: number) => {
    setExpandedSubtasks((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])

  /** Retorna o motivo do último retorno/erro da subtarefa (para exibição direta na linha). */
  const ultimoMotivoRetorno = useCallback((sub: SubTaskMotor): string | null => {
    const history = sub.deliveryHistory ?? []
    // Busca o último evento que indica retorno/rejeição (gate_rejected, return_for_rework, blocked)
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry) continue
      if (entry.eventType === "gate_rejected" || entry.eventType === "return_for_rework" || entry.eventType === "blocked") {
        return entry.reason ?? `Retorno (${entry.eventType}) na entrega #${entry.deliverNumber}`
      }
    }
    return null
  }, [])

  /** Label legível para o tipo de evento do histórico. */
  const labelEventType = useCallback((eventType: string): string => {
    const mapa: Record<string, string> = {
      delivery_started: "Entrega iniciada",
      gate_rejected: "Gate rejeitou",
      return_for_rework: "Retorno para rework",
      blocked: "Bloqueada",
      completed: "Concluída",
    }
    return mapa[eventType] ?? eventType
  }, [])

  /** Cor do chip por tipo de evento. */
  const corEventType = useCallback((eventType: string): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" => {
    switch (eventType) {
      case "completed": return "success"
      case "gate_rejected": return "error"
      case "return_for_rework": return "warning"
      case "blocked": return "error"
      case "delivery_started": return "info"
      default: return "default"
    }
  }, [])

  /** Formata data/hora para exibição compacta. */
  const formatarDataHora = useCallback((iso: string): string => {
    try {
      const d = new Date(iso)
      return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    } catch {
      return iso
    }
  }, [])

  /** ST-2: ao clicar em editar numa linha do motor, resolve a subtarefa do banco pelo seq. */
  const abrirEdicaoSubtarefa = useCallback(
    (motorSub: SubTaskMotor) => {
      const dbSub = subtarefasDb.find((s) => s.seq === motorSub.seq)
      if (!dbSub) {
        setEditSubError("Subtarefa ainda não sincronizada com o banco de dados.")
        setEditSubOpen(true)
        return
      }
      setEditSubError(null)
      setEditingSub(dbSub)
      setEditSubOpen(true)
    },
    [subtarefasDb],
  )

  const abrirSessaoSubtarefa = useCallback(async (subtask: SubTaskMotor) => {
    if (!bundle || tarefaId === "") return
    setSessionSubtask(subtask)
    setSessionOpen(true)
    setSessionLoading(true)
    setSessionError(null)
    setSessionData(null)
    try {
      const data = await bundle.http.request<SubtaskSession>(
        "GET",
        `/gerenteagentes/tarefas/${tarefaId}/subtarefas/${subtask.seq}/sessao`,
        { auth: "access" },
      )
      if (mounted.current) setSessionData(data)
    } catch (e) {
      if (mounted.current) setSessionError(e instanceof Error ? e.message : "Não foi possível carregar a sessão.")
    } finally {
      if (mounted.current) setSessionLoading(false)
    }
  }, [bundle, tarefaId])

  const abrirSessoesAnalista = useCallback(async () => {
    if (!bundle || tarefaId === "") return
    setAnalystSessionOpen(true)
    setAnalystSessionLoading(true)
    setAnalystSessionError(null)
    setAnalystSessionData(null)
    try {
      const data = await bundle.http.request<AnalystTaskSessionsResponse>(
        "GET",
        `/gerenteagentes/tarefas/${tarefaId}/sessoes-analista`,
        { auth: "access" },
      )
      if (mounted.current) setAnalystSessionData(data)
    } catch (e) {
      if (mounted.current) setAnalystSessionError(e instanceof Error ? e.message : "Não foi possível carregar as sessões do analista.")
    } finally {
      if (mounted.current) setAnalystSessionLoading(false)
    }
  }, [bundle, tarefaId])

  /**
   * O Motor-v2 expõe os dados da tarefa, mas subtarefas podem chegar vazias
   * durante uma atualização gradual do proxy. A tabela do projeto é a fonte
   * persistida para elas e já é carregada para permitir a edição; usá-la como
   * fallback mantém o acompanhamento consistente nesse intervalo.
   */
  const subtasks = useMemo<SubTaskMotor[]>(() => {
    const motorSubtasks = detail?.subtasks ?? []
    if (motorSubtasks.length > 0) return motorSubtasks
    return subtarefasDb.map((subtarefa) => ({
      seq: subtarefa.seq,
      title: subtarefa.titulo,
      status: subtarefa.status,
      blockInfo: subtarefa.resultado ? { reason: subtarefa.resultado } : null,
      scope: subtarefa.scope ?? null,
      acceptanceCriteria: subtarefa.acceptanceCriteria ?? null,
      workspaceStatus: subtarefa.workspaceStatus ?? null,
      correctionForSubtaskId: subtarefa.correctionForSubtaskId ?? null,
    }))
  }, [detail?.subtasks, subtarefasDb])

  /** Mapa id → seq para resolver subtarefa corrigida (correção de #X). */
  const subtaskIdToSeq = useMemo<Record<number, number>>(() => {
    const map: Record<number, number> = {}
    for (const s of subtarefasDb) {
      map[s.id] = s.seq
    }
    return map
  }, [subtarefasDb])

  const stats = useMemo(() => {
    const subs = subtasks
    const total = subs.length
    const verified = subs.filter((s) => s.status === "verified" || s.status === "completed").length
    const active = detail?.currentSubTask ?? subs.find((s) => ["running", "delivered", "verifying", "planning"].includes(s.status)) ?? null
    return { total, verified, active }
  }, [detail?.currentSubTask, subtasks])

  const tarefaSelecionada = tarefas.find((t) => t.id === tarefaId)
  const tarefasVisiveis = useMemo(() => {
    const busca = buscaTarefa.trim().toLocaleLowerCase("pt-BR")
    return tarefas.filter((tarefa) => {
      if (statusFiltro && tarefa.status !== statusFiltro) return false
      return !busca || `#${tarefa.id} ${tarefa.titulo}`.toLocaleLowerCase("pt-BR").includes(busca)
    })
  }, [tarefas, statusFiltro, buscaTarefa])
  const tarefasParaMapa = useMemo(() => {
    const projetoNomePorId = new Map(projetos.map((p) => [p.id, p.nome]))
    return tarefas.map((t) => ({
      ...t,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? null,
      projetoNome: projetoNomePorId.get(t.projetoId) ?? null,
    }))
  }, [tarefas, projetos])
  const statusMotor = detail?.task?.status ?? tarefaSelecionada?.status ?? "—"
  const isPaused = statusMotor === "paused"
  const podeIniciar = !isPaused && STATUS_INICIO_PERMITIDO.has(statusMotor)
  const podePausar = !isPaused && STATUS_EXECUCAO.has(statusMotor)
  const aguardandoRetentativaPromocao = /Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção:/i
    .test(detail?.task?.blockInfo?.excerpt ?? "")
  const podeRetomar = isPaused

  const editInitialValues = useMemo<DynamicFormValues>(() => {
    if (!tarefaSelecionada) return { titulo: "", descricao: "", tipo: "desenvolvimento", status: "draft", dependsOnTaskId: "" }
    return {
      titulo: tarefaSelecionada.titulo,
      descricao: tarefaSelecionada.descricao ?? "",
      tipo: tarefaSelecionada.tipo ?? "desenvolvimento",
      status: tarefaSelecionada.status ?? "draft",
      dependsOnTaskId: tarefaSelecionada.dependsOnTaskId ?? "",
    }
  }, [tarefaSelecionada])

  const eventos = detail?.events ?? []
  const tipoTarefa = tarefaSelecionada?.tipo ?? "desenvolvimento"
  const isDesenvolvimento = tipoTarefa === "desenvolvimento"

  const taskChatPanel = tarefaId !== "" ? (
    <Paper variant="outlined" sx={{ mt: 2, p: 2 }} data-testid="task-chat">
      <Typography variant="h6" sx={{ mb: 1 }}>Chat da tarefa</Typography>
      <Box
        data-testid="task-chat-history"
        sx={{
          minHeight: 96,
          maxHeight: 360,
          overflowY: "auto",
          p: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
          bgcolor: "background.default",
          borderRadius: 1,
        }}
      >
        {chatLoading && (
          <Stack alignItems="center" spacing={1} sx={{ py: 3 }} data-testid="task-chat-loading">
            <CircularProgress size={24} />
            <Typography color="text.secondary" variant="body2">Carregando histórico…</Typography>
          </Stack>
        )}
        {chatError && <Alert severity="error" sx={{ py: 0 }} data-testid="task-chat-error">{chatError}</Alert>}
        {!chatLoading && chat.length === 0 && !chatError && (
          <Typography color="text.secondary" variant="body2" align="center" sx={{ py: 3 }} data-testid="empty-task-chat">
            Nenhuma mensagem ainda. Inicie a conversa!
          </Typography>
        )}
        {chat.map((mensagem) => {
          const fromAgent = mensagem.role === "assistant" || mensagem.role === "agent" || mensagem.role === "analyst"
          return (
            <Box
              key={mensagem.id}
              sx={{
                alignSelf: fromAgent ? "flex-start" : "flex-end",
                maxWidth: { xs: "90%", sm: "75%" },
                px: 1.5,
                py: 1,
                borderRadius: 2,
                bgcolor: fromAgent ? "action.hover" : "primary.main",
                color: fromAgent ? "text.primary" : "primary.contrastText",
              }}
              data-testid={`task-chat-message-${mensagem.id}`}
            >
              <Typography variant="caption" sx={{ opacity: 0.75, display: "block" }}>
                {fromAgent ? "Agente" : "Você"}
                {mensagem.createdAt ? ` · ${new Date(mensagem.createdAt).toLocaleString("pt-BR")}` : ""}
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{mensagem.texto}</Typography>
            </Box>
          )
        })}
      </Box>
      {chatWaitingResponse && !chatSending && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }} data-testid="task-chat-typing">
          Agente está respondendo…
        </Typography>
      )}
      {realtimeStatus === "connecting" && (
        <Typography variant="caption" color="warning.main" sx={{ mt: 1 }} data-testid="task-chat-reconnecting">
          Reconectando ao tempo real…
        </Typography>
      )}
      {realtimeStatus === "closed" && (
        <Typography variant="caption" color="error.main" sx={{ mt: 1 }} data-testid="task-chat-connection-error">
          Conexão em tempo real indisponível. Tentando reconectar…
        </Typography>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={4}
          placeholder="Escreva uma mensagem para a tarefa…"
          value={chatInput}
          disabled={chatSending}
          onChange={(event) => setChatInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void enviarMensagemChat()
            }
          }}
          inputProps={{ "data-testid": "task-chat-input" }}
          helperText="Ctrl+Enter para enviar; Enter para nova linha"
        />
        <Button
          variant="contained"
          onClick={() => void enviarMensagemChat()}
          disabled={!chatInput.trim() || chatSending}
          startIcon={chatSending ? <CircularProgress size={16} color="inherit" /> : <SendRounded />}
          aria-label="Enviar mensagem do chat da tarefa"
          data-testid="task-chat-send-button"
          sx={{ alignSelf: "flex-end", minWidth: 110 }}
        >
          Enviar
        </Button>
      </Stack>
    </Paper>
  ) : null

  // 6.1 — Handler para seleção de tarefa: abre bottom sheet em mobile
  // MOVIDO antes do early return para respeitar as Rules of Hooks
  const handleSelectTask = useCallback((id: number) => {
    setTarefaId(id)
    if (isMobile) {
      setBottomSheetOpen(true)
    }
  }, [isMobile])

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="loading-spinner">
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Stack spacing={3} sx={{ width: "90%", mx: "auto" }} data-testid="task-monitor-screen">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="center">
        <Typography variant="h4" fontWeight={600}>Acompanhar Tarefa</Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Tooltip title="Pausa todas as tarefas que não estão concluídas/deployadas">
            <span>
              <Button
                variant="outlined"
                startIcon={<PauseRounded />}
                disabled={pausandoTodas || !tarefas.some((t) => !STATUS_FINAIS.has(t.status) && t.status !== 'paused')}
                loading={pausandoTodas}
                onClick={() => void executarAcaoBulk('pause-all')}
                data-testid="btn-pause-all"
              >
                Pausar todas
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Retoma todas as tarefas pausadas">
            <span>
              <Button
                variant="outlined"
                startIcon={<ReplayRounded />}
                disabled={retomandoTodas || !tarefas.some((t) => t.status === 'paused')}
                loading={retomandoTodas}
                onClick={() => void executarAcaoBulk('resume-all')}
                data-testid="btn-resume-all"
              >
                Retomar todas
              </Button>
            </span>
          </Tooltip>
          <Button
            variant="contained" startIcon={<AddTaskRounded />} onClick={() => {
              setNewTaskError(null)
              setNewTaskOpen(true)
            }} data-testid="btn-new-task"
          >
            Nova Tarefa
          </Button>
          <Typography variant="caption" color={realtimeStatus === "open" ? "success.main" : "text.secondary"}>
            {realtimeStatus === "open" ? "Tempo real conectado" : "Reconectando ao tempo real…"}
          </Typography>
        </Stack>
      </Stack>

      {erro && <Alert severity="error" data-testid="error-alert">{erro}</Alert>}
      {bulkMessage && (
        <Alert
          severity={bulkMessage.type}
          onClose={() => setBulkMessage(null)}
          data-testid="bulk-message-alert"
        >
          {bulkMessage.text}
        </Alert>
      )}

      {/* Sessão 1: Mapa vivo da tarefa */}
      <Box data-testid="task-map-section">
        <TaskFlowMap
          tarefas={tarefasParaMapa}
          selectedTaskId={tarefaId}
          search={buscaTarefa}
          motorActivities={motorActivities}
          onSelectTask={handleSelectTask}
          projetos={projetos}
          filtros={filtrosMapa}
          onFiltrosChange={setFiltrosMapa}
          aoVivo={realtimeStatus === "open"}
          carregando={loading}
          onStartTask={(id) => void iniciarTarefaId(id)}
          onPauseTask={(id) => void pausarTarefaId(id)}
          onResumeTask={(id) => void retomarTarefaId(id)}
        />
      </Box>

      {/* Sessão 2: Filtros + detalhes da tarefa, em moldura única */}
      <Paper variant="outlined" sx={{ p: 2 }} data-testid="task-monitoring-section">
        <Stack spacing={2}>
          {/* Filtros removidos — agora integrados ao topo do mapa (TaskFlowMap) */}
          {/* A seleção de tarefa é feita apenas pelo clique nos cards do mapa */}

      {tarefaSelecionada && (
        <>
          <Box data-testid="task-detail-section">
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h6">{tarefaSelecionada.titulo}</Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                fontWeight={600}
                aria-label={`ID da tarefa ${tarefaSelecionada.id}`}
                title={`ID da tarefa ${tarefaSelecionada.id}`}
                data-testid="selected-task-id"
              >
                #{tarefaSelecionada.id}
              </Typography>
              <IconButton
                size="small"
                aria-label="Editar tarefa"
                onClick={() => {
                  setEditError(null)
                  setEditOpen(true)
                }}
                data-testid="btn-edit-task"
              >
                <EditRounded fontSize="small" />
              </IconButton>
              <Tooltip title={aguardandoRetentativaPromocao ? "O Motor tentará novamente a promoção quando o repositório estiver limpo" : "Desbloquear tarefa"}>
                <IconButton
                  size="small"
                  aria-label="Desbloquear tarefa"
                  onClick={() => void desbloquearTarefa()}
                  disabled={acao !== null || aguardandoRetentativaPromocao}
                  data-testid="btn-unlock-task"
                >
                  <LockOpenRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Visualizar sessões do analista">
                <IconButton
                  size="small"
                  aria-label="Visualizar sessões do analista"
                  onClick={() => void abrirSessoesAnalista()}
                  data-testid="btn-view-analyst-sessions"
                >
                  <PsychologyRounded fontSize="small" />
                </IconButton>
              </Tooltip>
              <Chip size="small" label={statusMotor} color={corStatus(statusMotor)} data-testid="task-status-pill" />
              <Chip
                size="small"
                variant="outlined"
                label={TIPO_TAREFA_LABEL[tipoTarefa] ?? tipoTarefa}
                data-testid="task-type-pill"
              />
              {isDesenvolvimento && detail?.exists && (
                <Chip size="small" variant="outlined" label={`Progresso: ${stats.verified} / ${stats.total}`} data-testid="task-progress" />
              )}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                startIcon={<PlayArrowRounded />}
                disabled={acao !== null || !podeIniciar}
                onClick={() => void executarAcao("start")}
                data-testid="btn-start"
              >
                Iniciar
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<PauseRounded />}
                disabled={acao !== null || !podePausar}
                onClick={() => void executarAcao("pause")}
                data-testid="btn-pause"
              >
                Pausar
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ReplayRounded />}
                disabled={acao !== null || !podeRetomar}
                onClick={() => void executarAcao("resume")}
                data-testid="btn-resume"
              >
                Retomar
              </Button>
            </Stack>
          </Stack>

          {detail && !detail.exists && (
            <Alert severity="info" sx={{ mt: 2 }} data-testid="not-on-motor">
              {detail.message ?? "Tarefa ainda não enviada ao motor."} Clique em <b>Iniciar</b> para começar.
            </Alert>
          )}

          {detail?.exists && statusMotor === "paused" && (
            <Alert severity="warning" sx={{ mt: 2 }} data-testid="task-paused-banner">
              <Typography variant="body2">
                <b>⏸ Tarefa pausada:</b> A execução está suspensa. Clique em <b>Retomar</b> para continuar.
              </Typography>
            </Alert>
          )}

          {detail?.exists && statusMotor === "blocked" && detail.task?.blockInfo && (
            <Alert severity="error" sx={{ mt: 2 }} data-testid="task-block-banner">
              <Typography variant="body2">
                <b>⛔ Tarefa bloqueada:</b>{" "}
                {detail.task.blockInfo.excerpt || detail.task.errorMessage || "Falha não especificada."}
              </Typography>
              <Typography variant="caption" component="div" sx={{ color: "text.secondary" }}>
                Motivo: {detail.task.blockInfo.kind || "desconhecido"}
                {detail.task.blockInfo.blockedAt
                  ? ` · ${new Date(detail.task.blockInfo.blockedAt).toLocaleString("pt-BR")}`
                  : ""}
                {detail.task.blockInfo.subtaskId ? ` · Subtarefa #${detail.task.blockInfo.subtaskId}` : ""}
              </Typography>
            </Alert>
          )}

          {detail?.exists && !detail.task?.blockInfo && statusMotor === "blocked" && detail.task?.errorMessage && (
            <Alert severity="warning" sx={{ mt: 2 }} data-testid="task-block-warning">
              <Typography variant="body2">
                <b>⚠ Tarefa bloqueada:</b> {detail.task.errorMessage}
              </Typography>
            </Alert>
          )}

          {detail?.task?.promotionConflictAnalysis && (
            <Alert severity={detail.task.promotionConflictAnalysis.status === "failed" ? "warning" : "info"} sx={{ mt: 2 }} data-testid="promotion-conflict-analysis">
              <Typography variant="body2">
                <b>🔎 Análise automática do conflito:</b> {detail.task.promotionConflictAnalysis.status === "analyzing" ? "em andamento" : detail.task.promotionConflictAnalysis.status}
                {detail.task.promotionConflictAnalysis.confidence ? ` · confiança ${detail.task.promotionConflictAnalysis.confidence}` : ""}
              </Typography>
              {detail.task.promotionConflictAnalysis.conflictFiles.length > 0 && (
                <Typography variant="caption" component="div">Arquivos: {detail.task.promotionConflictAnalysis.conflictFiles.join(", ")}</Typography>
              )}
              {detail.task.promotionConflictAnalysis.report && (
                <Box component="details" sx={{ mt: 1 }}>
                  <Box component="summary" sx={{ cursor: "pointer", fontWeight: 600 }}>Ver diagnóstico e estratégia sugerida</Box>
                  <Typography component="pre" variant="caption" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", mt: 1 }}>{detail.task.promotionConflictAnalysis.report}</Typography>
                </Box>
              )}
              {detail.task.promotionConflictAnalysis.errorMessage && (
                <Typography variant="caption" component="div">Falha da análise: {detail.task.promotionConflictAnalysis.errorMessage}</Typography>
              )}
            </Alert>
          )}

          {detail?.exists && stats.active && (
            <Alert severity="info" icon={false} sx={{ mt: 2, bgcolor: "background.paper" }} data-testid="task-banner">
              <Typography variant="body2">
                <b>▶ Executando:</b> {stats.active.title} <Chip size="small" label={stats.active.status} color={corStatus(stats.active.status)} sx={{ ml: 1 }} />
              </Typography>
            </Alert>
          )}

          {detail?.exists && isDesenvolvimento && (
            <>
              <Table size="small" sx={{ mt: 2 }} data-testid="subtask-table">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell>
                    <TableCell>Subtarefa</TableCell>
                    <TableCell sx={{ maxWidth: 240 }}>Escopo</TableCell>
                    <TableCell align="center">Critérios</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Workspace</TableCell>
                    <TableCell align="right">Entregas</TableCell>
                    <TableCell align="center" sx={{ width: 48 }}>Ações</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {subtasks.map((s) => {
                    const ativa = stats.active && s.seq === stats.active.seq
                    const criterioCount = contarCriterios(s.acceptanceCriteria)
                    const correctedSeq = s.correctionForSubtaskId != null ? subtaskIdToSeq[s.correctionForSubtaskId] : undefined
                    const history = s.deliveryHistory ?? []
                    const isExpanded = expandedSubtasks.has(s.seq)
                    const motivoRetorno = ultimoMotivoRetorno(s)
                    return (
                      <React.Fragment key={s.seq}>
                      <TableRow
                        sx={ativa ? { bgcolor: "action.hover", boxShadow: "inset 3px 0 0 currentColor" } : undefined}
                        data-testid={`subtask-row-${s.seq}`}
                      >
                        <TableCell>{ativa ? "▶ " : ""}{s.seq}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                            <Typography component="span" variant="body2">{s.title}</Typography>
                            {s.correctionForSubtaskId != null && (
                              <Chip
                                size="small"
                                color="warning"
                                variant="outlined"
                                label={correctedSeq != null ? `Correção de #${correctedSeq}` : "Correção"}
                                data-testid={`correction-badge-${s.seq}`}
                              />
                            )}
                          </Stack>
                          {s.blockInfo?.reason && (
                            <Typography variant="caption" display="block" color="text.secondary">
                              🚫 {s.blockInfo.reason}
                              {s.blockInfo.command ? ` · ${s.blockInfo.command}` : ""}
                              {s.blockInfo.exitCode != null ? ` · exit ${s.blockInfo.exitCode}` : ""}
                            </Typography>
                          )}
                          {motivoRetorno && (
                            <Typography
                              variant="caption"
                              display="block"
                              sx={{ color: "warning.light", fontStyle: "italic", mt: 0.25 }}
                              data-testid={`subtask-return-reason-${s.seq}`}
                            >
                              ↩ {motivoRetorno}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 240 }}>
                          {s.scope ? (
                            <Tooltip title={s.scope} arrow placement="top">
                              <Typography
                                variant="caption"
                                sx={{
                                  display: "-webkit-box",
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: "vertical",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  wordBreak: "break-word",
                                }}
                                data-testid={`scope-text-${s.seq}`}
                              >
                                {s.scope}
                              </Typography>
                            </Tooltip>
                          ) : (
                            <Typography variant="caption" color="text.secondary">—</Typography>
                          )}
                        </TableCell>
                        <TableCell align="center">
                          <Chip
                            size="small"
                            variant="outlined"
                            label={criterioCount}
                            color={criterioCount > 0 ? "primary" : "default"}
                            data-testid={`criteria-count-${s.seq}`}
                          />
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={s.status} color={corStatus(s.status)} />
                        </TableCell>
                        <TableCell>
                          {s.workspaceStatus ? (
                            <Chip size="small" variant="outlined" label={s.workspaceStatus} data-testid={`workspace-status-${s.seq}`} />
                          ) : (
                            <Typography variant="caption" color="text.secondary">—</Typography>
                          )}
                        </TableCell>
                        <TableCell align="right">{s.deliverCount ?? 0}</TableCell>
                        <TableCell align="center">
                          <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
                            <IconButton
                              size="small"
                              aria-label={`Editar subtarefa ${s.seq}`}
                              onClick={() => abrirEdicaoSubtarefa(s)}
                              data-testid={`btn-edit-subtask-${s.seq}`}
                            >
                              <EditRounded fontSize="small" />
                            </IconButton>
                            <Tooltip title="Visualizar sessão do agente">
                              <IconButton
                                size="small"
                                aria-label={`Visualizar sessão da subtarefa ${s.seq}`}
                                onClick={() => void abrirSessaoSubtarefa(s)}
                                data-testid={`btn-view-session-${s.seq}`}
                              >
                                <VisibilityRounded fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            {history.length > 0 && (
                              <Tooltip title={isExpanded ? "Recolher histórico" : "Ver histórico de entregas"}>
                                <IconButton
                                  size="small"
                                  onClick={() => toggleSubtaskHistory(s.seq)}
                                  data-testid={`btn-toggle-history-${s.seq}`}
                                >
                                  {isExpanded
                                    ? <ExpandLessRounded fontSize="small" />
                                    : <ExpandMoreRounded fontSize="small" />}
                                </IconButton>
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                      {isExpanded && history.length > 0 && (
                        <TableRow>
                          <TableCell colSpan={8} sx={{ py: 1, px: 2, backgroundColor: "action.hover" }}>
                            <Box sx={{ pl: 4 }}>
                              <Typography variant="caption" sx={{ fontWeight: 600, mb: 0.5, display: "block" }}>
                                Histórico de entregas ({history.length} evento{history.length !== 1 ? "s" : ""})
                              </Typography>
                              <Table size="small" data-testid={`delivery-history-${s.seq}`}>
                                <TableHead>
                                  <TableRow>
                                    <TableCell sx={{ fontWeight: 600, py: 0.5 }}>#</TableCell>
                                    <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Evento</TableCell>
                                    <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Modelo</TableCell>
                                    <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Data/Hora</TableCell>
                                    <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Motivo</TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {history.map((entry) => (
                                    <TableRow key={entry.id}>
                                      <TableCell sx={{ fontFamily: "monospace", py: 0.5 }}>{entry.deliverNumber}</TableCell>
                                      <TableCell sx={{ py: 0.5 }}>
                                        <Chip
                                          label={labelEventType(entry.eventType)}
                                          size="small"
                                          color={corEventType(entry.eventType)}
                                          variant="outlined"
                                          sx={{ height: 20, fontSize: "0.7rem" }}
                                        />
                                      </TableCell>
                                      <TableCell sx={{ fontFamily: "monospace", fontSize: "0.75rem", py: 0.5 }}>
                                        {entry.model ?? "—"}
                                      </TableCell>
                                      <TableCell sx={{ fontFamily: "monospace", fontSize: "0.75rem", py: 0.5 }}>
                                        {formatarDataHora(entry.createdAt)}
                                      </TableCell>
                                      <TableCell sx={{ py: 0.5, maxWidth: 300 }}>
                                        <Typography
                                          variant="caption"
                                          sx={{
                                            wordBreak: "break-word",
                                            color: (entry.eventType === "gate_rejected" || entry.eventType === "blocked") ? "error.light" : "text.secondary",
                                          }}
                                        >
                                          {entry.reason ?? "—"}
                                        </Typography>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </Box>
                          </TableCell>
                        </TableRow>
                      )}
                      </React.Fragment>
                    )
                  })}
                  {subtasks.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8}>
                        <Typography color="text.secondary" data-testid="empty-subtasks">
                          Nenhuma subtarefa ainda — o motor está planejando a execução.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              <Typography variant="h6" sx={{ mt: 3 }}>Atividade</Typography>
              <Paper variant="outlined" sx={{ p: 2, maxHeight: 260, overflow: "auto" }} data-testid="activity-feed">
                {eventos.length === 0 && (
                  <Typography color="text.secondary" variant="body2">Nenhum evento ainda.</Typography>
                )}
                {[...eventos].reverse().map((ev, i) => (
                  <Box key={`${ev.at}-${i}`} sx={{ py: 0.5, borderBottom: "1px dashed", borderColor: "divider" }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                      {new Date(ev.at).toLocaleTimeString("pt-BR")}
                    </Typography>
                    <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                      {traduzirEvento(ev.type)}
                    </Typography>
                    {ev.payload && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ pl: 8 }}>
                        {JSON.stringify(ev.payload).slice(0, 160)}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Paper>

              <Typography variant="h6" sx={{ mt: 3 }}>Terminal</Typography>
              <Paper
                variant="outlined"
                sx={{ p: 2, bgcolor: "grey.950", color: "grey.100", fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}
                data-testid="task-terminal"
              >
                {terminalEvents.length === 0 && "Aguardando saída do comando…"}
                {terminalEvents.map((message, index) => {
                  if (message.type !== "event") return null
                  const event = message.event
                  const payload = event.payload
                  if (event.type === "task.command.output") return <Box key={`${event.eventId}-${index}`} component="span" sx={{ color: payload.stream === "stderr" ? "error.light" : "inherit" }}>{String(payload.text ?? "")}</Box>
                  if (event.type === "task.command.started") return <Box key={`${event.eventId}-${index}`} sx={{ color: "info.light", mb: 1 }}>{`$ ${String(payload.displayCommand ?? "")}`}</Box>
                  if (event.type === "task.command.finished") return <Box key={`${event.eventId}-${index}`} sx={{ color: payload.success ? "success.light" : "error.light", mb: 1 }}>{`[exit ${String(payload.exitCode ?? "null")}] duração ${String(payload.durationMs ?? 0)}ms`}</Box>
                  return null
                })}
              </Paper>
            </>
          )}

          {taskChatPanel}
          </Box>
        </>
      )}
        </Stack>
      </Paper>

      <Dialog
        open={sessionOpen}
        onClose={() => {
          if (!sessionLoading) setSessionOpen(false)
        }}
        fullWidth
        maxWidth="lg"
        data-testid="session-dialog"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box>Sessão do agente{sessionSubtask ? ` — subtarefa #${sessionSubtask.seq}` : ""}</Box>
          <IconButton aria-label="Fechar sessão" size="small" onClick={() => setSessionOpen(false)} disabled={sessionLoading}>
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {sessionLoading && <Stack direction="row" spacing={1} alignItems="center" data-testid="session-loading"><CircularProgress size={20} /><Typography>Carregando sessão…</Typography></Stack>}
          {sessionError && <Alert severity="error" data-testid="session-error">{sessionError}</Alert>}
          {!sessionLoading && !sessionError && sessionData && !sessionData.available && (
            <Typography color="text.secondary" data-testid="session-unavailable">Nenhuma sessão disponível para esta subtarefa.</Typography>
          )}
          {!sessionLoading && !sessionError && sessionData?.available && (
            <Box component="pre" data-testid="session-content" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "65vh", overflow: "auto", m: 0, p: 2, bgcolor: "action.hover", borderRadius: 1, fontFamily: "monospace", fontSize: "0.85rem" }}>
              {sessionData.text}
            </Box>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={analystSessionOpen}
        onClose={() => {
          if (!analystSessionLoading) setAnalystSessionOpen(false)
        }}
        fullWidth
        maxWidth="lg"
        data-testid="analyst-session-dialog"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box>Sessões do analista</Box>
          <IconButton aria-label="Fechar sessões do analista" size="small" onClick={() => setAnalystSessionOpen(false)} disabled={analystSessionLoading}>
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {analystSessionLoading && <Stack direction="row" spacing={1} alignItems="center" data-testid="analyst-session-loading"><CircularProgress size={20} /><Typography>Carregando sessões do analista…</Typography></Stack>}
          {analystSessionError && <Alert severity="error" data-testid="analyst-session-error">{analystSessionError}</Alert>}
          {!analystSessionLoading && !analystSessionError && analystSessionData && !analystSessionData.available && (
            <Typography color="text.secondary" data-testid="analyst-session-unavailable">Nenhuma sessão do analista registrada para esta tarefa.</Typography>
          )}
          {!analystSessionLoading && !analystSessionError && analystSessionData?.available && analystSessionData.sessions.length === 0 && (
            <Typography color="text.secondary" data-testid="analyst-session-empty">Nenhuma sessão do analista encontrada.</Typography>
          )}
          {!analystSessionLoading && !analystSessionError && analystSessionData?.available && analystSessionData.sessions.length > 0 && (
            <Stack spacing={2} data-testid="analyst-session-list">
              {analystSessionData.sessions.map((session) => (
                <Paper key={session.sessionKey} variant="outlined" sx={{ p: 2 }} data-testid={`analyst-session-${session.executionOrder}`}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <PsychologyRounded fontSize="small" color="primary" />
                    <Typography variant="subtitle2" fontWeight={700} data-testid={`analyst-session-model-${session.executionOrder}`}>
                      Modelo: {session.model}
                    </Typography>
                    <Chip size="small" label={`Sessão ${session.executionOrder}`} color="primary" variant="outlined" />
                    <Chip size="small" label={session.status} color={session.status === "active" ? "success" : session.status === "closed" ? "default" : "warning"} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: "block" }}>
                    Aberta: {new Date(session.openedAt).toLocaleString("pt-BR")}
                    {session.closedAt ? ` · Encerrada: ${new Date(session.closedAt).toLocaleString("pt-BR")}` : ""}
                    {session.closeReason ? ` · Motivo: ${session.closeReason}` : ""}
                  </Typography>
                  <Box component="pre" data-testid={`analyst-session-content-${session.executionOrder}`} sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "40vh", overflow: "auto", m: 0, p: 2, bgcolor: "action.hover", borderRadius: 1, fontFamily: "monospace", fontSize: "0.85rem" }}>
                    {session.text}
                  </Box>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={newTaskOpen}
        onClose={(_ev, reason) => {
          if (reason === "backdropClick" || newTaskLoading) return
          setNewTaskOpen(false)
        }}
        fullWidth
        maxWidth="md"
        data-testid="new-task-dialog"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box>Nova tarefa</Box>
          <IconButton
            aria-label="Fechar formulário de nova tarefa" size="small" disabled={newTaskLoading}
            onClick={() => setNewTaskOpen(false)} data-testid="btn-close-new-task"
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <TarefaForm
            projetos={projetos}
            loading={newTaskLoading}
            error={newTaskError}
            onSubmit={handleNewTaskSubmit}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onClose={(_ev, reason) => {
          if (reason === "backdropClick") return
          if (editLoading) return
          setEditOpen(false)
        }}
        fullWidth
        maxWidth="md"
        data-testid="edit-task-dialog"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box>Editar tarefa</Box>
          <IconButton
            aria-label="Fechar formulário"
            size="small"
            disabled={editLoading}
            onClick={() => setEditOpen(false)}
            data-testid="btn-close-edit"
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {editError && (
            <Alert severity="error" data-testid="edit-error-alert">
              {editError}
            </Alert>
          )}
          {tarefaSelecionada && (
            <Box sx={{ pt: 1 }}>
              <DynamicForm
                key={`edit-${tarefaId}`}
                fields={editFields}
                initialValues={editInitialValues}
                loading={editLoading}
                actionState="update"
                submitLabel="Salvar alterações"
                onSubmit={handleEditSubmit}
                onCancel={() => setEditOpen(false)}
              />
            </Box>
          )}
        </DialogContent>
      </Dialog>

      {/* ST-2: Diálogo de edição de subtarefa */}
      <Dialog
        open={editSubOpen}
        onClose={(_ev, reason) => {
          if (reason === "backdropClick") return
          if (editSubLoading) return
          setEditSubOpen(false)
          setEditingSub(null)
        }}
        fullWidth
        maxWidth="md"
        data-testid="edit-subtask-dialog"
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Box>Editar subtarefa{editingSub ? ` #${editingSub.seq}` : ""}</Box>
          <IconButton
            aria-label="Fechar formulário de subtarefa"
            size="small"
            disabled={editSubLoading}
            onClick={() => {
              setEditSubOpen(false)
              setEditingSub(null)
            }}
            data-testid="btn-close-edit-subtask"
          >
            <CloseRounded />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {editSubError && (
            <Alert severity="error" data-testid="edit-sub-error-alert">
              {editSubError}
            </Alert>
          )}
          {editingSub && (
            <Box sx={{ pt: 1 }}>
              <DynamicForm
                key={`edit-sub-${editingSub.id}`}
                fields={editSubFields}
                initialValues={editSubInitialValues}
                loading={editSubLoading}
                actionState="update"
                submitLabel="Salvar alterações"
                onSubmit={handleEditSubSubmit}
                onCancel={() => {
                  setEditSubOpen(false)
                  setEditingSub(null)
                }}
              />
            </Box>
          )}
        </DialogContent>
      </Dialog>

      {/* 6.1 — Bottom sheet para detalhe da tarefa em mobile */}
      <Drawer
        anchor="bottom"
        open={bottomSheetOpen}
        onClose={() => setBottomSheetOpen(false)}
        keepMounted
        data-testid="task-detail-sheet"
        sx={{
          display: { xs: "block", sm: "none" },
          "& .MuiDrawer-paper": {
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: "60vh",
            p: 2,
          },
        }}
      >
        <Stack spacing={2}>
          {/* Handle visual */}
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <Box sx={{ width: 40, height: 4, borderRadius: 2, bgcolor: "text.disabled" }} />
          </Box>
          {tarefaSelecionada && (
            <>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                <Typography variant="h6" fontWeight={600}>
                  #{tarefaSelecionada.id} {tarefaSelecionada.titulo}
                </Typography>
                <IconButton
                  onClick={() => setBottomSheetOpen(false)}
                  size="small"
                  aria-label="Fechar detalhe"
                >
                  <CloseRounded />
                </IconButton>
              </Stack>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip
                  label={taskStatusLabel(tarefaSelecionada.status)}
                  color={corStatus(tarefaSelecionada.status)}
                  size="small"
                />
                {tarefaSelecionada.tipo && (
                  <Chip label={TIPO_TAREFA_LABEL[tarefaSelecionada.tipo] ?? tarefaSelecionada.tipo} size="small" variant="outlined" />
                )}
              </Stack>
              {tarefaSelecionada.descricao && (
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                  {tarefaSelecionada.descricao.length > 200
                    ? `${tarefaSelecionada.descricao.slice(0, 200)}...`
                    : tarefaSelecionada.descricao}
                </Typography>
              )}
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setBottomSheetOpen(false)
                  // Scroll até a seção de detalhes
                  const detailSection = document.querySelector('[data-testid="task-detail-section"]')
                  if (detailSection) {
                    detailSection.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                }}
                data-testid="sheet-view-full"
              >
                Ver detalhe completo
              </Button>
            </>
          )}
        </Stack>
      </Drawer>
    </Stack>
  )
}
