import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material"
import { AddTaskRounded, CloseRounded, PauseRounded, PlayArrowRounded, ReplayRounded, SendRounded } from "@mui/icons-material"
import { RealtimeClient } from "@biblioteca-global/api-client"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveApiBaseUrl, resolveRealtimeUrl } from "../../../apps/web/src/api/client"
import { taskStatusLabel } from "../motor-v2/src/shared/task-statuses"
import TaskFlowMap, { type FiltrosMapa, type FlowTask, type MotorActivity, type RecoveryEligibility } from "./TaskFlowMap"

export const componentId = "gerenteagentes-operation-map"

interface Task {
  id: number
  titulo: string
  descricao?: string | null
  tipo?: string | null
  status: string
  projetoId: number
  createdAt?: string
  updatedAt?: string
  subtaskCount?: number
  recoveryEligibility?: RecoveryEligibility | null
}

interface TaskDetail {
  exists: boolean
  message?: string
  task?: { status: string; title: string; errorMessage?: string; blockInfo?: { excerpt?: string; kind?: string } | null }
  subtasks?: Array<{ seq: number; title: string; status: string; deliverCount?: number }>
  currentSubTask?: { seq: number; title: string; status: string } | null
  events?: Array<{ at: string; type: string; payload?: Record<string, unknown> }>
}

interface ChatMessage {
  id: number
  role: string
  texto: string
  createdAt: string
}

const EMPTY_FILTERS: FiltrosMapa = { busca: "", status: [], projetoId: "", prioridade: "" }

function navigateTo(path: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("bg:navigate", { detail: { path } }))
}

function Stat({ value, label, color }: { value: number; label: string; color?: string }) {
  return <Typography variant="body2"><Box component="span" sx={{ fontFamily: "monospace", fontWeight: 800, color }}>{value}</Box> {label}</Typography>
}

export default function OperationMapScreen() {
  const bundle = useApi()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Array<{ id: number; nome: string }>>([])
  const [selectedId, setSelectedId] = useState<number | "">("")
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState("")
  const [chatLoading, setChatLoading] = useState(false)
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tab, setTab] = useState(0)
  const [filters, setFilters] = useState<FiltrosMapa>(EMPTY_FILTERS)
  const [activities, setActivities] = useState<MotorActivity[]>([])
  const [realtime, setRealtime] = useState<"connecting" | "open" | "closed">("closed")
  const activeTask = useRef<number | "">("")

  const loadTasks = useCallback(async () => {
    if (!bundle) return
    try {
      const result = await bundle.http.request<Task[]>("GET", "/gerenteagentes/tarefas-com-status", { query: { pageSize: 100 }, auth: "access" })
      setTasks(result ?? [])
      setSelectedId((current) => current !== "" && result?.some((task) => task.id === current) ? current : result?.[0]?.id ?? "")
    } catch { /* a tela de observabilidade permanece utilizável durante reinícios da API */ }
  }, [bundle])

  const loadProjects = useCallback(async () => {
    if (!bundle) return
    try {
      const result = await bundle.http.request<{ items: Array<{ id: number; nome: string }> }>("GET", "/gerenteagentes/projetos_captados", { query: { pageSize: 100 }, auth: "access" })
      setProjects(result.items ?? [])
    } catch { /* filtro de projeto fica vazio até nova tentativa */ }
  }, [bundle])

  const loadActivity = useCallback(async () => {
    if (!bundle) return
    try {
      const result = await bundle.http.request<{ activities?: MotorActivity[] }>("GET", "/gerenteagentes/motor-activity", { auth: "access" })
      setActivities(result.activities ?? [])
    } catch { setActivities([]) }
  }, [bundle])

  const loadSelected = useCallback(async (id: number) => {
    if (!bundle) return
    setChatLoading(true)
    try {
      const [nextDetail, nextChat] = await Promise.all([
        bundle.http.request<TaskDetail>("GET", `/gerenteagentes/tarefas/${id}/motor-detail`, { auth: "access" }),
        bundle.http.request<ChatMessage[] | { items?: ChatMessage[] }>("GET", `/gerenteagentes/tarefas/${id}/chat`, { auth: "access" }),
      ])
      setDetail(nextDetail)
      setChat(Array.isArray(nextChat) ? nextChat : nextChat.items ?? [])
      setChatError(null)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Não foi possível carregar os detalhes.")
    } finally { setChatLoading(false) }
  }, [bundle])

  useEffect(() => {
    void loadTasks(); void loadProjects(); void loadActivity()
    const interval = window.setInterval(() => { void loadTasks(); void loadActivity() }, 5000)
    return () => window.clearInterval(interval)
  }, [loadTasks, loadProjects, loadActivity])

  useEffect(() => {
    if (selectedId === "") return
    void loadSelected(selectedId)
    activeTask.current = selectedId
    setRealtime("connecting")
    const client = bundle ? new RealtimeClient({
      url: resolveRealtimeUrl(), baseUrl: resolveApiBaseUrl(), taskId: selectedId,
      getAccessToken: () => bundle.getAccessToken(),
      onStatusChange: setRealtime,
      onMessage: (message) => {
        if (activeTask.current !== selectedId || message.type !== "event") return
        if (message.event.type === "task.status.changed") {
          const status = message.event.payload.status
          if (typeof status === "string") setTasks((current) => current.map((task) => task.id === selectedId ? { ...task, status } : task))
        }
        void loadSelected(selectedId)
        void loadTasks()
      },
    }) : null
    void client?.connect()
    return () => { activeTask.current = ""; client?.close() }
  }, [selectedId, bundle, loadSelected, loadTasks])

  const selected = tasks.find((task) => task.id === selectedId)
  const mappedTasks = useMemo<FlowTask[]>(() => tasks.map((task) => ({ ...task, createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null, projetoNome: projects.find((project) => project.id === task.projetoId)?.nome ?? null })), [tasks, projects])
  const running = tasks.filter((task) => ["running", "analyzing", "motor_fix"].includes(task.status)).length
  const blocked = tasks.filter((task) => ["blocked", "failed"].includes(task.status)).length
  const awaiting = tasks.filter((task) => task.status === "awaiting_clarification").length

  const execute = async (action: "start" | "pause" | "resume") => {
    if (!bundle || selectedId === "") return
    await bundle.http.request("POST", `/gerenteagentes/tarefas/${selectedId}/${action}`, { auth: "access" })
    await loadTasks(); await loadSelected(selectedId)
  }

  const sendChat = async () => {
    if (!bundle || selectedId === "" || !chatInput.trim() || chatSending) return
    setChatSending(true)
    try {
      await bundle.http.request("POST", `/gerenteagentes/tarefas/${selectedId}/chat`, { body: { role: "user", texto: chatInput.trim() }, auth: "access" })
      setChatInput("")
      await loadSelected(selectedId)
    } catch (error) { setChatError(error instanceof Error ? error.message : "Não foi possível enviar a mensagem.") }
    finally { setChatSending(false) }
  }

  return <Box data-testid="operation-map-screen" sx={{ width: "100%", maxWidth: 1800, mx: "auto" }}>
    <Stack spacing={1.5}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }}>
        <Box><Typography variant="h4" fontWeight={750}>Mapa de agentes</Typography><Typography variant="body2" color="text.secondary">Visão operacional em tempo real</Typography></Box>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
          <Typography variant="caption" color={realtime === "open" ? "success.main" : "warning.main"}>● {realtime === "open" ? "Tempo real conectado" : "Reconectando…"}</Typography>
          <Stat value={tasks.length} label="tarefas" /><Stat value={running} label="executando" color="primary.main" /><Stat value={blocked} label="bloqueadas" color={blocked ? "error.main" : undefined} />
          {awaiting > 0 && <Chip color="warning" label={`⚠ ${awaiting} precisa${awaiting === 1 ? '' : 'm'} de você`} onClick={() => { const task = tasks.find((item) => item.status === "awaiting_clarification"); if (task) { setSelectedId(task.id); setDrawerOpen(true) } }} />}
          <Button variant="contained" startIcon={<AddTaskRounded />} onClick={() => navigateTo("nova-tarefa")}>Nova tarefa</Button>
        </Stack>
      </Stack>
      <TaskFlowMap tarefas={mappedTasks} selectedTaskId={selectedId} motorActivities={activities} projetos={projects} filtros={filters} onFiltrosChange={setFilters} aoVivo={realtime === "open"} onSelectTask={(id) => { setSelectedId(id); setDrawerOpen(true); setTab(0) }} />
    </Stack>
    <Drawer anchor="right" open={drawerOpen && selectedId !== ""} onClose={() => setDrawerOpen(false)} data-testid="operation-task-drawer" PaperProps={{ sx: { width: { xs: "100%", sm: "40vw", lg: "38vw" }, maxWidth: 620 } }}>
      {selected && <Stack sx={{ height: "100%" }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ p: 2 }}><Box><Typography variant="h6">#{selected.id} {selected.titulo}</Typography><Chip size="small" label={taskStatusLabel(detail?.task?.status ?? selected.status)} sx={{ mt: .75 }} /></Box><IconButton onClick={() => setDrawerOpen(false)} aria-label="Fechar detalhe"><CloseRounded /></IconButton></Stack>
        <Divider />
        <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" aria-label="Detalhes da tarefa"><Tab label="Resumo" /><Tab label="Chat" /><Tab label="Execução" /><Tab label="Logs" /><Tab label="Histórico" /></Tabs>
        <Box sx={{ p: 2, flex: 1, overflow: "auto" }}>
          {tab === 0 && <Stack spacing={2}><Typography color="text.secondary">{selected.descricao || "Sem descrição"}</Typography>{detail?.task?.blockInfo && <Alert severity="error">{detail.task.blockInfo.excerpt || detail.task.blockInfo.kind || "Tarefa bloqueada"}</Alert>}<Stack direction="row" spacing={1}><Button size="small" variant="contained" startIcon={<PlayArrowRounded />} onClick={() => void execute("start")} disabled={selected.status === "running"}>Iniciar</Button><Button size="small" variant="outlined" startIcon={<PauseRounded />} onClick={() => void execute("pause")} disabled={selected.status !== "running"}>Pausar</Button><Button size="small" variant="outlined" startIcon={<ReplayRounded />} onClick={() => void execute("resume")} disabled={selected.status !== "paused"}>Retomar</Button></Stack></Stack>}
          {tab === 1 && <Stack spacing={1.5}><Typography variant="caption" color="text.secondary">Chat da tarefa</Typography>{chatLoading && <CircularProgress size={20} />}{chatError && <Alert severity="error">{chatError}</Alert>}{chat.map((message) => <Box key={message.id} sx={{ alignSelf: message.role === "user" ? "flex-end" : "flex-start", maxWidth: "90%", p: 1.25, borderRadius: 1.5, bgcolor: message.role === "user" ? "primary.main" : "action.hover", color: message.role === "user" ? "primary.contrastText" : "text.primary" }}><Typography variant="caption" display="block">{message.role === "user" ? "Você" : "Agente"}</Typography><Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{message.texto}</Typography></Box>)}<Stack direction="row" spacing={1} sx={{ mt: "auto" }}><TextField fullWidth multiline minRows={2} placeholder="Responder…" value={chatInput} onChange={(event) => setChatInput(event.target.value)} inputProps={{ "data-testid": "operation-chat-input" }} /><Button variant="contained" onClick={() => void sendChat()} disabled={!chatInput.trim() || chatSending} startIcon={<SendRounded />}>Enviar</Button></Stack></Stack>}
          {tab === 2 && <Stack spacing={1}>{detail?.subtasks?.map((subtask) => <Stack key={subtask.seq} direction="row" justifyContent="space-between"><Typography variant="body2">{subtask.seq}. {subtask.title}</Typography><Chip size="small" label={taskStatusLabel(subtask.status)} /></Stack>) ?? <Typography color="text.secondary">Sem dados de execução.</Typography>}</Stack>}
          {tab === 3 && <Stack spacing={1}>{detail?.events?.map((event, index) => <Typography key={`${event.at}-${index}`} variant="body2"><Box component="span" sx={{ fontFamily: "monospace", color: "text.secondary", mr: 1 }}>{new Date(event.at).toLocaleTimeString("pt-BR")}</Box>{event.type}</Typography>) ?? <Typography color="text.secondary">Nenhum log disponível.</Typography>}</Stack>}
          {tab === 4 && <Stack spacing={1}>{detail?.events?.slice().reverse().map((event, index) => <Typography key={`${event.at}-${index}`} variant="body2">{new Date(event.at).toLocaleString("pt-BR")} · {event.type}</Typography>) ?? <Typography color="text.secondary">Nenhum histórico disponível.</Typography>}</Stack>}
        </Box>
      </Stack>}
    </Drawer>
  </Box>
}
