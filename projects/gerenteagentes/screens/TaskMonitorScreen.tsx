/**
 * TaskMonitorScreen — acompanhamento em TEMPO REAL da execução de tarefas
 * no motor GerenteAgentes (reproduz o dashboard-standalone.html do motor
 * dentro da biblioteca).
 *
 * - Polling de 5s no endpoint proxy /gerenteagentes/tarefas/:id/motor-detail
 * - Subtarefas com status, progresso (verified/total), banner da subtarefa atual
 * - Activity feed com os eventos do motor
 * - Ações: iniciar / pausar / retomar
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
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
  Typography,
} from "@mui/material"
import { PlayArrowRounded, PauseRounded, ReplayRounded, EditRounded, CloseRounded } from "@mui/icons-material"
import { DynamicForm } from "@biblioteca-global/ui"
import { RealtimeClient, type RealtimeServerMessage } from "@biblioteca-global/api-client"
import type { DynamicField, DynamicFormValues } from "@biblioteca-global/ui"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveRealtimeUrl } from "../../../apps/web/src/api/client"

interface Tarefa {
  id: number
  titulo: string
  descricao?: string | null
  dependsOnTaskId?: number | null
  status: string
  projetoId: number
  updatedAt?: string
  createdAt?: string
}

interface ProjetoCaptado {
  id: number
  nome: string
}

/** Status conhecidos do schema + status finais que o motor pode gravar. */
const STATUS_OPCOES = [
  "draft",
  "planned",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "finalizada",
  "deployada",
  "aborted",
] as const

interface SubTaskMotor {
  seq: number
  title: string
  status: string
  deliverCount?: number
  blockInfo?: { reason?: string; command?: string; exitCode?: number | null } | null
}

/** Subtarefa do banco de dados (para edição — o motor só tem seq/title/status). */
interface SubTarefaDb {
  id: number
  tarefaId: number
  seq: number
  titulo: string
  descricao?: string | null
  status: string
  resultado?: string | null
  dependsOnSubtaskId?: number | null
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
  task?: { id: string; status: string; title: string }
  subtasks?: SubTaskMotor[]
  currentSubTask?: SubTaskMotor | null
  events?: MotorEvent[]
  errors?: Array<{ subtaskId?: string; ok?: boolean; failures?: string }>
  models?: Array<{ model: string; tierIndex?: number; reason?: string; occurredAt?: string }>
}

const STATUS_FINAIS = new Set(["completed", "finalizada", "deployada", "aborted"])

function corStatus(status: string): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" {
  switch (status) {
    case "verified":
    case "completed":
    case "finalizada":
    case "deployada":
      return "success"
    case "delivered":
    case "running":
    case "planning":
      return "info"
    case "verifying":
    case "paused":
      return "warning"
    case "rejected":
    case "blocked":
    case "failed":
    case "aborted":
      return "error"
    default:
      return "default"
  }
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

export default function TaskMonitorScreen(): ReactNode {
  const bundle = useApi()
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [projetos, setProjetos] = useState<ProjetoCaptado[]>([])
  const [projetoFiltro, setProjetoFiltro] = useState<number | "">("")
  const [statusFiltro, setStatusFiltro] = useState<string>("")
  const [tarefaId, setTarefaId] = useState<number | "">("")
  const [detail, setDetail] = useState<MotorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [acao, setAcao] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
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
  const mounted = useRef(true)

  const carregarProjetos = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<{ items: ProjetoCaptado[] }>(
        "GET",
        "/projetos_captados",
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
      const res = await bundle.http.request<{ items: Tarefa[] }>("GET", "/tarefas", {
        query,
        auth: "access",
      })
      const lista = (res.items ?? []).sort((a, b) =>
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

  useEffect(() => {
    mounted.current = true
    void carregarProjetos()
    void carregarTarefas()
    const t1 = setInterval(() => {
      void carregarTarefas()
    }, 30000)
    return () => {
      mounted.current = false
      clearInterval(t1)
    }
  }, [carregarProjetos, carregarTarefas])

  // Polling de 60s no detalhe (tempo real)
  useEffect(() => {
    if (tarefaId === "") return
    void carregarDetail(tarefaId)
    void carregarSubtarefasDb(tarefaId)
    const t2 = setInterval(() => {
      void carregarDetail(tarefaId)
      void carregarSubtarefasDb(tarefaId)
    }, 60000)
    return () => clearInterval(t2)
  }, [tarefaId, carregarDetail, carregarSubtarefasDb])

  useEffect(() => {
    if (tarefaId === "") return
    setTerminalEvents([])
    const realtime = new RealtimeClient({
      url: resolveRealtimeUrl(),
      taskId: tarefaId,
      onStatusChange: setRealtimeStatus,
      onMessage: (message) => {
        if (message.type !== "event") return
        setTerminalEvents((atual) => [...atual, message].slice(-500))
        if (message.event.type === "task.status.changed") {
          const status = String(message.event.payload.status ?? "")
          setTarefas((atual) => atual.map((tarefa) => tarefa.id === tarefaId ? { ...tarefa, status } : tarefa))
        }
      },
    })
    realtime.connect()
    return () => realtime.close()
  }, [tarefaId])

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
          dependsOnTaskId:
            values.dependsOnTaskId !== "" && values.dependsOnTaskId != null
              ? Number(values.dependsOnTaskId)
              : null,
        }
        await bundle.http.request("PUT", `/tarefas/${tarefaId}`, {
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
  const editSubFields: DynamicField[] = useMemo(
    () => [
      { name: "titulo", label: "Título", type: "text", required: true, maxLength: 200, fullWidth: true },
      {
        name: "status",
        label: "Status",
        type: "select",
        options: [
          { label: "Pendente", value: "pending" },
          { label: "Executando", value: "running" },
          { label: "Verificada", value: "verified" },
          { label: "Falhou", value: "failed" },
        ],
      },
      { name: "seq", label: "Ordem", type: "number", min: 0 },
      { name: "descricao", label: "Descrição", type: "textarea", fullWidth: true },
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
    if (!editingSub) return { titulo: "", status: "pending", seq: 0, descricao: "", resultado: "", dependsOnSubtaskId: "" }
    return {
      titulo: editingSub.titulo,
      status: editingSub.status,
      seq: editingSub.seq,
      descricao: editingSub.descricao ?? "",
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
        const body: Record<string, unknown> = {
          titulo: String(values.titulo ?? "").trim(),
          status: String(values.status ?? "pending"),
          seq: Number(values.seq ?? 0),
          descricao: values.descricao ? String(values.descricao).trim() : null,
          resultado: values.resultado ? String(values.resultado).trim() : null,
          dependsOnSubtaskId:
            values.dependsOnSubtaskId !== "" && values.dependsOnSubtaskId != null
              ? Number(values.dependsOnSubtaskId)
              : null,
        }
        await bundle.http.request("PUT", `/subtarefas/${editingSub.id}`, {
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

  const stats = useMemo(() => {
    const subs = detail?.subtasks ?? []
    const total = subs.length
    const verified = subs.filter((s) => s.status === "verified" || s.status === "completed").length
    const active = detail?.currentSubTask ?? subs.find((s) => ["running", "delivered", "verifying", "planning"].includes(s.status)) ?? null
    return { total, verified, active }
  }, [detail])

  const tarefaSelecionada = tarefas.find((t) => t.id === tarefaId)
  const statusMotor = detail?.task?.status ?? tarefaSelecionada?.status ?? "—"

  const editInitialValues = useMemo<DynamicFormValues>(() => {
    if (!tarefaSelecionada) return { titulo: "", descricao: "", dependsOnTaskId: "" }
    return {
      titulo: tarefaSelecionada.titulo,
      descricao: tarefaSelecionada.descricao ?? "",
      dependsOnTaskId: tarefaSelecionada.dependsOnTaskId ?? "",
    }
  }, [tarefaSelecionada])

  const eventos = detail?.events ?? []

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="loading-spinner">
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Stack spacing={3} data-testid="task-monitor-screen">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="center">
        <Typography variant="h4" fontWeight={600}>
          Acompanhar Tarefa
        </Typography>
          <Typography variant="caption" color={realtimeStatus === "open" ? "success.main" : "text.secondary"}>
          {realtimeStatus === "open" ? "Tempo real conectado" : "Reconectando ao tempo real…"}
        </Typography>
      </Stack>

      {erro && <Alert severity="error" data-testid="error-alert">{erro}</Alert>}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} flexWrap="wrap" useFlexGap>
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel>Projeto</InputLabel>
          <Select
            label="Projeto"
            value={projetoFiltro}
            onChange={(e) => setProjetoFiltro(String(e.target.value) === "" ? "" : Number(e.target.value))}
            data-testid="select-projeto"
          >
            <MenuItem value="">Todos os projetos</MenuItem>
            {projetos.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.nome}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Status</InputLabel>
          <Select
            label="Status"
            value={statusFiltro}
            onChange={(e) => setStatusFiltro(String(e.target.value))}
            data-testid="select-status"
          >
            <MenuItem value="">Todos</MenuItem>
            {STATUS_OPCOES.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 320 }}>
          <InputLabel>Tarefa</InputLabel>
          <Select
            label="Tarefa"
            value={tarefaId}
            onChange={(e) => setTarefaId(Number(e.target.value))}
            data-testid="select-tarefa"
          >
            {tarefas.length === 0 && (
              <MenuItem value="" disabled>
                Nenhuma tarefa com os filtros selecionados
              </MenuItem>
            )}
            {tarefas.map((t) => (
              <MenuItem key={t.id} value={t.id}>
                #{t.id} — {t.titulo} ({t.status})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {tarefaSelecionada && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h6">{tarefaSelecionada.titulo}</Typography>
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
              <Chip size="small" label={statusMotor} color={corStatus(statusMotor)} data-testid="task-status-pill" />
              {detail?.exists && (
                <Chip size="small" variant="outlined" label={`Progresso: ${stats.verified} / ${stats.total}`} data-testid="task-progress" />
              )}
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                startIcon={<PlayArrowRounded />}
                disabled={acao !== null || ["running", "planning"].includes(statusMotor)}
                onClick={() => void executarAcao("start")}
                data-testid="btn-start"
              >
                Iniciar
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<PauseRounded />}
                disabled={acao !== null || !["running", "planning"].includes(statusMotor)}
                onClick={() => void executarAcao("pause")}
                data-testid="btn-pause"
              >
                Pausar
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ReplayRounded />}
                disabled={acao !== null || !["paused"].includes(statusMotor)}
                onClick={() => void executarAcao("resume")}
                data-testid="btn-resume"
              >
                Retomar
              </Button>
            </Stack>
          </Stack>

          {detail && !detail.exists && (
            <Alert severity="info" sx={{ mt: 2 }} data-testid="not-on-motor">
              {detail.message ?? "Tarefa ainda não enviada ao motor."} Clique em <b>Iniciar</b> para começar o desenvolvimento.
            </Alert>
          )}

          {detail?.exists && stats.active && (
            <Alert severity="info" icon={false} sx={{ mt: 2, bgcolor: "background.paper" }} data-testid="task-banner">
              <Typography variant="body2">
                <b>▶ Executando:</b> {stats.active.title} <Chip size="small" label={stats.active.status} color={corStatus(stats.active.status)} sx={{ ml: 1 }} />
              </Typography>
            </Alert>
          )}

          {detail?.exists && (
            <>
              <Table size="small" sx={{ mt: 2 }} data-testid="subtask-table">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell>
                    <TableCell>Subtarefa</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Entregas</TableCell>
                    <TableCell align="center" sx={{ width: 48 }}>Ações</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(detail.subtasks ?? []).map((s) => {
                    const ativa = stats.active && s.seq === stats.active.seq
                    return (
                      <TableRow
                        key={s.seq}
                        sx={ativa ? { bgcolor: "action.hover", boxShadow: "inset 3px 0 0 currentColor" } : undefined}
                        data-testid={`subtask-row-${s.seq}`}
                      >
                        <TableCell>{ativa ? "▶ " : ""}{s.seq}</TableCell>
                        <TableCell>
                          {s.title}
                          {s.blockInfo?.reason && (
                            <Typography variant="caption" display="block" color="text.secondary">
                              🚫 {s.blockInfo.reason}
                              {s.blockInfo.command ? ` · ${s.blockInfo.command}` : ""}
                              {s.blockInfo.exitCode != null ? ` · exit ${s.blockInfo.exitCode}` : ""}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={s.status} color={corStatus(s.status)} />
                        </TableCell>
                        <TableCell align="right">{s.deliverCount ?? 0}</TableCell>
                        <TableCell align="center">
                          <IconButton
                            size="small"
                            aria-label={`Editar subtarefa ${s.seq}`}
                            onClick={() => abrirEdicaoSubtarefa(s)}
                            data-testid={`btn-edit-subtask-${s.seq}`}
                          >
                            <EditRounded fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {(detail.subtasks ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5}>
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
        </Paper>
      )}

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
    </Stack>
  )
}
