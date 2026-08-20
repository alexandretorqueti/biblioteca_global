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
  FormControl,
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
import { PlayArrowRounded, PauseRounded, ReplayRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

interface Tarefa {
  id: number
  titulo: string
  status: string
  projetoId: number
  updatedAt?: string
  createdAt?: string
}

interface SubTaskMotor {
  seq: number
  title: string
  status: string
  deliverCount?: number
  blockInfo?: { reason?: string; command?: string; exitCode?: number | null } | null
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
  const [tarefaId, setTarefaId] = useState<number | "">("")
  const [detail, setDetail] = useState<MotorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [acao, setAcao] = useState<string | null>(null)
  const mounted = useRef(true)

  const carregarTarefas = useCallback(async () => {
    if (!bundle) return
    try {
      const res = await bundle.http.request<{ items: Tarefa[] }>("GET", "/tarefas", {
        query: { pageSize: 100 },
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
  }, [bundle])

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

  useEffect(() => {
    mounted.current = true
    void carregarTarefas()
    const t1 = setInterval(() => void carregarTarefas(), 30000)
    return () => {
      mounted.current = false
      clearInterval(t1)
    }
  }, [carregarTarefas])

  // Polling de 5s no detalhe (tempo real)
  useEffect(() => {
    if (tarefaId === "") return
    void carregarDetail(tarefaId)
    const t2 = setInterval(() => void carregarDetail(tarefaId), 5000)
    return () => clearInterval(t2)
  }, [tarefaId, carregarDetail])

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

  const stats = useMemo(() => {
    const subs = detail?.subtasks ?? []
    const total = subs.length
    const verified = subs.filter((s) => s.status === "verified" || s.status === "completed").length
    const active = detail?.currentSubTask ?? subs.find((s) => ["running", "delivered", "verifying", "planning"].includes(s.status)) ?? null
    return { total, verified, active }
  }, [detail])

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="loading-spinner">
        <CircularProgress />
      </Box>
    )
  }

  const tarefaSelecionada = tarefas.find((t) => t.id === tarefaId)
  const statusMotor = detail?.task?.status ?? tarefaSelecionada?.status ?? "—"
  const eventos = detail?.events ?? []

  return (
    <Stack spacing={3} data-testid="task-monitor-screen">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="center">
        <Typography variant="h4" fontWeight={600}>
          Acompanhar Tarefa
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Atualização automática a cada 5s
        </Typography>
      </Stack>

      {erro && <Alert severity="error" data-testid="error-alert">{erro}</Alert>}

      <FormControl size="small" sx={{ minWidth: 320 }}>
        <InputLabel>Tarefa</InputLabel>
        <Select
          label="Tarefa"
          value={tarefaId}
          onChange={(e) => setTarefaId(Number(e.target.value))}
          data-testid="select-tarefa"
        >
          {tarefas.map((t) => (
            <MenuItem key={t.id} value={t.id}>
              #{t.id} — {t.titulo} ({t.status})
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {tarefaSelecionada && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h6">{tarefaSelecionada.titulo}</Typography>
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
                      </TableRow>
                    )
                  })}
                  {(detail.subtasks ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4}>
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
            </>
          )}
        </Paper>
      )}
    </Stack>
  )
}
