/**
 * OperationMapCanvas — "Mission Control" da operação (Mapa de agentes).
 *
 * Esta é uma REPRESENTAÇÃO alternativa da operação. Ela consome exatamente os
 * mesmos dados/endpoints do acompanhamento legado (tarefas-com-status,
 * motor-activity, motor-deploy-diagnostics) e não contém regra de negócio:
 * toda ação (selecionar tarefa, iniciar/pausar, chat, edições) mora na tela
 * que a hospeda (OperationMapScreen).
 *
 * Metáfora visual: mapa de metrô + sala de controle industrial.
 * Os estados são ESTAÇÕES de um fluxo vivo; as tarefas são marcadores que
 * percorrem esse fluxo.
 *
 * Preservações obrigatórias (equivalência com a tela antiga):
 * - Toda tarefa permanece acessível (marcador → clique abre o detalhe).
 * - Carregamento incremental por estação (mostra até 5; expande para ver todas).
 * - Deployadas nunca viram uma lista ilimitada (densidade + recentes + "Ver todas").
 * - Busca/projeto/status/prioridade filtram o mapa.
 * - Estados excepcionais destacam-se quando há ocorrências e ficam discretos em zero.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Popover,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material"
import {
  AccountTreeRounded,
  BoltRounded,
  BuildRounded,
  CancelRounded,
  CenterFocusStrongRounded,
  CheckCircleRounded,
  ContentPasteRounded,
  EditNoteRounded,
  FilterAltRounded,
  HourglassBottomRounded,
  InsightsRounded,
  MemoryRounded,
  PauseCircleRounded,
  ReplyRounded,
  RocketLaunchRounded,
  SearchRounded,
  SettingsRounded,
  ViewListRounded,
  WarningAmberRounded,
  ZoomInRounded,
  ZoomOutRounded,
} from "@mui/icons-material"
import { deriveTaskPriority, formatTempoRelativo, projetoAvatar, type Prioridade } from "./taskFlowHelpers"
import {
  getEffectiveStatus,
  MAIN_FLOW,
  SIDE_FLOW,
  type FiltrosMapa,
  type FlowTask,
  type MotorActivity,
} from "./TaskFlowMap"

// ============================================================================
// TIPOS DE ENTRADA (dados do motor — apenas apresentação)
// ============================================================================

/** Worker ativo reportado por GET /gerenteagentes/motor-activity. */
export interface MotorWorker {
  executionId: string
  taskId: string
  subtaskId?: number | null
  phase?: string
  executionPhase?: string | null
  projectSlug?: string | null
  startedAt?: string
  ageMs?: number
  lastHeartbeatAt?: string | null
}

/** Deploy ativo reportado por GET /gerenteagentes/motor-activity. */
export interface MotorDeployment {
  taskId: string
  phase?: string
  startedAt?: string
  ageMs?: number
}

/** Recorte do payload de /api/motor/stats usado pelo mapa. */
export interface MotorStats {
  activeWorkers?: number
  maxWorkers?: number
  workers?: MotorWorker[]
  deployments?: MotorDeployment[]
  activities?: MotorActivity[]
}

export interface OperationMapCanvasProps {
  tarefas: FlowTask[]
  selectedTaskId: number | ""
  projetos: Array<{ id: number; nome: string }>
  motorActivities?: MotorActivity[]
  workers?: MotorWorker[]
  activeWorkers?: number
  maxWorkers?: number
  deployments?: MotorDeployment[]
  filtros?: FiltrosMapa
  onFiltrosChange?: (filtros: FiltrosMapa) => void
  onSelectTask: (id: number) => void
  aoVivo?: boolean
}

// ============================================================================
// ESTAÇÕES
// ============================================================================

type StationTone = "neutral" | "active" | "success" | "warning" | "danger"

const STATION_ICONS: Record<string, React.ComponentType<{ sx?: object }>> = {
  draft: EditNoteRounded,
  planned: ContentPasteRounded,
  analyzing: SearchRounded,
  ready: HourglassBottomRounded,
  running: SettingsRounded,
  completed: CheckCircleRounded,
  deployed: RocketLaunchRounded,
  waiting: PauseCircleRounded,
  repair: BuildRounded,
  attention: WarningAmberRounded,
  closed: CancelRounded,
}

const ALL_STATIONS = [...MAIN_FLOW, ...SIDE_FLOW]

/** Quantos marcadores cada estação mostra antes de exigir "ver todas". */
const MARKER_LIMIT = 5
/** Acima disso, a estação passa a comunicar volume por densidade. */
const DENSITY_HINT = 12

interface StatusFilter { value: string; label: string; statuses: string[] }

const STATUS_FILTERS: StatusFilter[] = [
  { value: "em-execucao", label: "Em execução", statuses: ["running", "analyzing", "motor_fix"] },
  { value: "aguardando", label: "Aguardando você", statuses: ["awaiting_clarification"] },
  { value: "bloqueadas", label: "Bloqueadas", statuses: ["blocked", "failed"] },
  { value: "concluidas", label: "Concluídas", statuses: ["completed", "finalizada", "deployed", "deployada"] },
]

const EMPTY_FILTERS: FiltrosMapa = { busca: "", status: [], projetoId: "", prioridade: "" }

const PRIORITY_LABEL: Record<Prioridade, string> = { alta: "Alta", media: "Média", baixa: "Baixa" }

type ToneToken = "text.disabled" | "primary.main" | "success.main" | "warning.main" | "error.main"

function toneColor(tone: StationTone): ToneToken {
  const map: Record<StationTone, ToneToken> = {
    neutral: "text.disabled",
    active: "primary.main",
    success: "success.main",
    warning: "warning.main",
    danger: "error.main",
  }
  return map[tone]
}

function priorityColor(priority: Prioridade): ToneToken {
  const map: Record<Prioridade, ToneToken> = { alta: "error.main", media: "warning.main", baixa: "success.main" }
  return map[priority]
}

/** Status "efetivo" (paused sem subtarefas conta como rascunho). */
function stationOf(task: FlowTask) {
  const effective = getEffectiveStatus(task)
  return ALL_STATIONS.find(station => station.statuses.includes(effective))
    ?? SIDE_FLOW[2]!
}

// ============================================================================
// ANIMAÇÕES (discretas, respeitam prefers-reduced-motion)
// ============================================================================

const ANIMATION_STYLE_ID = "operation-map-animations"

function ensureAnimationStyles() {
  if (typeof document === "undefined") return
  if (document.getElementById(ANIMATION_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = ANIMATION_STYLE_ID
  style.textContent = `
    @keyframes operation-map-dash { to { background-position-x: 14px; } }
    @keyframes operation-map-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
    .operation-map-link--active {
      background-image: repeating-linear-gradient(90deg, currentColor 0 6px, transparent 6px 14px);
      animation: operation-map-dash .9s linear infinite;
    }
    .operation-map-pulse { animation: operation-map-pulse 2.6s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) {
      .operation-map-link--active, .operation-map-pulse { animation: none !important; }
    }
  `
  document.head.appendChild(style)
}

// ============================================================================
// COMPONENTES INTERNOS
// ============================================================================

function RailLink({ active }: { active: boolean }) {
  return (
    <Box
      aria-hidden="true"
      className={active ? "operation-map-link--active" : undefined}
      sx={{
        flex: "0 0 auto",
        alignSelf: "center",
        width: { xs: 22, md: 40 },
        height: 3,
        borderRadius: 1,
        bgcolor: active ? undefined : "divider",
        color: "primary.main",
        position: "relative",
        "&::after": {
          content: '""',
          position: "absolute",
          right: -1,
          top: "50%",
          transform: "translateY(-50%)",
          borderLeft: "5px solid",
          borderTop: "4px solid transparent",
          borderBottom: "4px solid transparent",
          color: active ? "primary.main" : "divider",
        },
      }}
    />
  )
}

interface MarkerProps {
  task: FlowTask
  stationLabel: string
  selected: boolean
  moving: boolean
  onSelectTask: (id: number) => void
}

function TaskMarker({ task, stationLabel, selected, moving, onSelectTask }: MarkerProps) {
  const priority = deriveTaskPriority(task.status)
  const needsReply = getEffectiveStatus(task) === "awaiting_clarification"
  const tempo = formatTempoRelativo(task.updatedAt)
  const nome = task.projetoNome ?? `Projeto ${task.projetoId}`
  const avatar = projetoAvatar(task.projetoId, task.projetoNome ?? null)

  return (
    <Tooltip
      arrow
      title={
        <Box>
          <Typography variant="caption" display="block" fontWeight={700}>
            #{task.id} {task.titulo}
          </Typography>
          <Typography variant="caption" display="block">{stationLabel} · atualizada {tempo}</Typography>
          <Typography variant="caption" display="block">Prioridade {PRIORITY_LABEL[priority]}</Typography>
          <Typography variant="caption" display="block">
            {avatar.letra} · {nome}
          </Typography>
          {needsReply && (
            <Typography variant="caption" display="block" fontWeight={700}>💬 Resposta necessária</Typography>
          )}
        </Box>
      }
    >
      <IconButton
        size="small"
        onClick={() => onSelectTask(task.id)}
        aria-label={`Abrir tarefa ${task.id}: ${task.titulo} (${stationLabel})`}
        data-testid={`operation-map-task-${task.id}`}
        sx={{
          p: 0.3,
          borderRadius: "50%",
          color: priorityColor(priority),
          border: selected ? 2 : 0,
          borderColor: "primary.main",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Box
          className={moving || needsReply ? "operation-map-pulse" : undefined}
          sx={{
            width: 11,
            height: 11,
            borderRadius: "50%",
            bgcolor: "currentColor",
            boxShadow: selected ? "0 0 0 3px color-mix(in srgb, currentColor 22%, transparent)" : undefined,
          }}
        />
      </IconButton>
    </Tooltip>
  )
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function OperationMapCanvas({
  tarefas,
  selectedTaskId,
  projetos,
  motorActivities = [],
  workers = [],
  activeWorkers,
  maxWorkers,
  deployments = [],
  filtros: filtrosExternos,
  onFiltrosChange,
  onSelectTask,
  aoVivo = true,
}: OperationMapCanvasProps) {
  const [filtrosInternos, setFiltrosInternos] = useState<FiltrosMapa>(EMPTY_FILTERS)
  const filtros = filtrosExternos ?? filtrosInternos
  const setFiltros = onFiltrosChange ?? setFiltrosInternos

  const [view, setView] = useState<"mapa" | "lista" | "atividade">("mapa")
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [stationFocus, setStationFocus] = useState<string>("")
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [workersAnchor, setWorkersAnchor] = useState<HTMLElement | null>(null)
  const panRef = useRef<{ x: number; y: number } | null>(null)
  const previousStations = useRef<Map<number, string>>(new Map())
  const [movingIds, setMovingIds] = useState<Set<number>>(new Set())

  useEffect(() => { ensureAnimationStyles() }, [])

  // Detecta transições de estação para animar discretamente o movimento.
  useEffect(() => {
    const next = new Map<number, string>()
    const moved: number[] = []
    for (const task of tarefas) {
      const stationId = stationOf(task).id
      next.set(task.id, stationId)
      const previous = previousStations.current.get(task.id)
      if (previous && previous !== stationId) moved.push(task.id)
    }
    previousStations.current = next
    if (!moved.length) return
    setMovingIds(current => new Set([...current, ...moved]))
    const timer = window.setTimeout(() => {
      setMovingIds(current => {
        const copy = new Set(current)
        for (const id of moved) copy.delete(id)
        return copy
      })
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [tarefas])

  const filtradas = useMemo(() => tarefas.filter(task => {
    const query = filtros.busca.trim().toLocaleLowerCase("pt-BR")
    if (query && !(`#${task.id} ${task.titulo}`).toLocaleLowerCase("pt-BR").includes(query)) return false
    if (filtros.projetoId !== "" && task.projetoId !== filtros.projetoId) return false
    if (filtros.prioridade && deriveTaskPriority(task.status) !== filtros.prioridade) return false
    if (filtros.status.length) {
      const statuses = filtros.status.flatMap(value => STATUS_FILTERS.find(item => item.value === value)?.statuses ?? [])
      if (!statuses.includes(task.status)) return false
    }
    return true
  }), [tarefas, filtros])

  const temFiltroAtivo = Boolean(filtros.busca || filtros.projetoId !== "" || filtros.prioridade || filtros.status.length)
  const porEstacao = useCallback(
    (stationId: string) => filtradas.filter(task => stationOf(task).id === stationId),
    [filtradas],
  )
  const totalPorEstacao = useCallback(
    (stationId: string) => tarefas.filter(task => stationOf(task).id === stationId).length,
    [tarefas],
  )
  const maxCount = useMemo(
    () => Math.max(1, ...ALL_STATIONS.map(station => porEstacao(station.id).length)),
    [porEstacao],
  )

  const emExecucao = filtradas.filter(task => ["running", "analyzing", "motor_fix"].includes(task.status)).length
  const bloqueadas = filtradas.filter(task => ["blocked", "failed"].includes(task.status)).length
  const aguardandoVoce = tarefas.filter(task => getEffectiveStatus(task) === "awaiting_clarification")
  const atividadeTaskIds = new Set(motorActivities.map(activity => String(activity.taskId)))
  const workersAtivos = activeWorkers ?? workers.length

  const updateFiltros = (next: Partial<FiltrosMapa>) => setFiltros({ ...filtros, ...next })
  const toggleStatus = (value: string) => updateFiltros({
    status: filtros.status.includes(value) ? filtros.status.filter(item => item !== value) : [...filtros.status, value],
  })
  const toggleExpand = (stationId: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(stationId)) next.delete(stationId)
    else next.add(stationId)
    return next
  })

  const verTodasDaEstacao = (stationId: string) => {
    setStationFocus(stationId)
    setView("lista")
  }

  // ── Pan por arrasto (somente quando o mapa não está em escala 1:1) ─────────
  const panEnabled = zoom !== 1 || pan.x !== 0 || pan.y !== 0
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!panEnabled) return
    panRef.current = { x: event.clientX - pan.x, y: event.clientY - pan.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!panRef.current) return
    setPan({ x: event.clientX - panRef.current.x, y: event.clientY - panRef.current.y })
  }
  const onPointerUp = () => { panRef.current = null }
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  // ── Cartão de estação ─────────────────────────────────────────────────────
  const StationNode = ({ stationId }: { stationId: string }) => {
    const station = ALL_STATIONS.find(item => item.id === stationId)!
    const Icon = STATION_ICONS[station.id] ?? AccountTreeRounded
    const tarefasEstacao = porEstacao(station.id)
    const total = totalPorEstacao(station.id)
    const expandido = expanded.has(station.id)
    const visiveis = expandido ? tarefasEstacao : tarefasEstacao.slice(0, MARKER_LIMIT)
    const restantes = Math.max(0, tarefasEstacao.length - visiveis.length)
    const ativa = station.tone === "active" && tarefasEstacao.length > 0
    const cor = toneColor(station.tone)
    const pct = total ? Math.max(4, Math.round((tarefasEstacao.length / maxCount) * 100)) : 0
    const destaque = station.tone === "danger" && tarefasEstacao.length > 0

    return (
      <Paper
        variant="outlined"
        elevation={0}
        data-testid={`operation-station-${station.id}`}
        sx={{
          flex: "1 1 168px",
          minWidth: { xs: 152, md: 158 },
          maxWidth: { xs: 280, md: 340 },
          p: 1.25,
          borderTop: 2,
          borderTopColor: cor,
          bgcolor: tarefasEstacao.length ? "background.paper" : "action.hover",
          opacity: tarefasEstacao.length ? 1 : 0.72,
          outline: destaque ? "1px solid" : "none",
          outlineColor: destaque ? "error.main" : "transparent",
          transition: "border-color 180ms ease, opacity 180ms ease",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Icon sx={{ color: cor, fontSize: 20, mt: 0.25 }} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="caption" fontWeight={800} textTransform="uppercase" letterSpacing=".05em" noWrap display="block">
              {station.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" noWrap>
              {station.subtitle}
            </Typography>
          </Box>
          <Stack alignItems="flex-end" sx={{ minWidth: 26 }}>
            <Typography variant="h6" fontWeight={800} lineHeight={1} data-testid={`operation-count-${station.id}`}>
              {tarefasEstacao.length}
            </Typography>
            {temFiltroAtivo && total !== tarefasEstacao.length && (
              <Typography variant="caption" color="text.disabled" lineHeight={1}>/{total}</Typography>
            )}
          </Stack>
        </Stack>

        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.75, minHeight: 18 }}>
          {ativa && (
            <Tooltip title="IA trabalhando nesta estação">
              <Typography variant="caption" color="primary.main" className="operation-map-pulse" aria-label="IA trabalhando">
                ◉ IA trabalhando
              </Typography>
            </Tooltip>
          )}
          {station.tone === "warning" && tarefasEstacao.length > 0 && (
            <Typography variant="caption" color="warning.main" fontWeight={700}>⚠ precisa de você</Typography>
          )}
          {station.tone === "danger" && tarefasEstacao.length > 0 && (
            <Typography variant="caption" color="error.main" fontWeight={700}>⚠ intervenção</Typography>
          )}
          {station.id === "deployed" && tarefasEstacao.length > 0 && (
            <Typography variant="caption" color="text.secondary">produção</Typography>
          )}
        </Stack>

        <Box
          data-testid={`operation-density-${station.id}`}
          sx={{ mt: 0.5, height: 4, borderRadius: 2, bgcolor: "action.hover", overflow: "hidden" }}
        >
          <Box sx={{ height: "100%", width: `${pct}%`, bgcolor: cor, borderRadius: 2, transition: "width 240ms ease" }} />
        </Box>

        <Box sx={{ mt: 0.75, minHeight: 30, display: "flex", gap: 0.25, alignItems: "center", flexWrap: "wrap" }}>
          {visiveis.map(task => (
            <TaskMarker
              key={task.id}
              task={task}
              stationLabel={station.label}
              selected={task.id === selectedTaskId}
              moving={movingIds.has(task.id) || atividadeTaskIds.has(String(task.id))}
              onSelectTask={onSelectTask}
            />
          ))}
          {!tarefasEstacao.length && <Typography variant="caption" color="text.disabled">vazio</Typography>}
        </Box>

        {tarefasEstacao.length > MARKER_LIMIT && (
          <Button
            size="small"
            data-testid={`operation-more-${station.id}`}
            onClick={() => {
              if (!expandido && tarefasEstacao.length >= DENSITY_HINT) verTodasDaEstacao(station.id)
              else toggleExpand(station.id)
            }}
            sx={{ mt: 0.25, minWidth: 0, p: 0, fontSize: 11, textTransform: "none" }}
          >
            {expandido ? "− recolher" : restantes >= DENSITY_HINT - MARKER_LIMIT ? `ver todas as ${tarefasEstacao.length} →` : `+${restantes}`}
          </Button>
        )}
      </Paper>
    )
  }

  const mainStations = MAIN_FLOW.filter(station => station.id !== "deployed")
  const exceptionStations = SIDE_FLOW
  const mainRailStations = mainStations
  const mainActive = (stationId: string) => atividadesDaEstacao(stationId)
  function atividadesDaEstacao(stationId: string) {
    const station = ALL_STATIONS.find(item => item.id === stationId)
    if (!station) return false
    return filtradas.some(task => station.statuses.includes(getEffectiveStatus(task)))
  }

  const listTasks = stationFocus ? filtradas.filter(task => stationOf(task).id === stationFocus) : filtradas
  const stationFocusLabel = ALL_STATIONS.find(item => item.id === stationFocus)?.label ?? ""
  const recentes = useMemo(
    () => [...tarefas].sort((a, b) => new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()).slice(0, 24),
    [tarefas],
  )

  return (
    <Paper variant="outlined" elevation={0} data-testid="operation-map-canvas" sx={{ overflow: "hidden" }}>
      <Stack spacing={1.5} sx={{ p: { xs: 1.5, md: 2 } }}>
        {/* ── Cabeçalho do canvas ─────────────────────────────────────────── */}
        <Stack direction={{ xs: "column", lg: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", lg: "center" }} spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center">
            <AccountTreeRounded color="primary" />
            <Box>
              <Typography variant="h6" fontWeight={800} lineHeight={1.2}>Mapa da operação</Typography>
              <Typography variant="caption" color="text.secondary">
                Fluxo vivo de tarefas · {filtradas.length} de {tarefas.length} tarefas
              </Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip size="small" variant="outlined" label={`${tarefas.length} tarefas`} />
            <Chip size="small" variant="outlined" color="info" label={`${emExecucao} executando`} />
            <Chip size="small" variant="outlined" color={bloqueadas ? "error" : "default"} label={`${bloqueadas} bloqueadas`} />
            <Button
              size="small"
              variant="outlined"
              color={workersAtivos ? "primary" : "inherit"}
              data-testid="operation-workers-indicator"
              startIcon={<MemoryRounded fontSize="small" />}
              onClick={event => setWorkersAnchor(event.currentTarget)}
              sx={{ textTransform: "none" }}
            >
              {workersAtivos} worker{workersAtivos === 1 ? "" : "s"} · {workersAtivos ? "ativos" : "ocioso"}
            </Button>
            {!aoVivo && (
              <Typography variant="caption" color="warning.main" data-testid="operation-realtime-warning">
                ○ reconectando…
              </Typography>
            )}
            <Button
              size="small"
              startIcon={<FilterAltRounded fontSize="small" />}
              onClick={() => setFiltersOpen(open => !open)}
              color={temFiltroAtivo ? "primary" : "inherit"}
            >
              {temFiltroAtivo ? "Filtros ativos" : "Filtros"}
            </Button>
          </Stack>
        </Stack>

        {/* ── Intervenção humana necessária ───────────────────────────────── */}
        {aguardandoVoce.length > 0 && (
          <Paper
            variant="outlined"
            data-testid="operation-intervention-banner"
            sx={{ p: 1, borderColor: "warning.main", bgcolor: "warning.main", color: "warning.contrastText", display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}
          >
            <WarningAmberRounded fontSize="small" />
            <Typography variant="body2" fontWeight={700} sx={{ flex: 1, minWidth: 180 }}>
              {aguardandoVoce.length} tarefa{aguardandoVoce.length === 1 ? "" : "s"} precisa{aguardandoVoce.length === 1 ? "" : "m"} de você
            </Typography>
            <Button
              size="small"
              variant="contained"
              color="inherit"
              startIcon={<ReplyRounded fontSize="small" />}
              onClick={() => onSelectTask(aguardandoVoce[0]!.id)}
              data-testid="operation-intervention-open"
            >
              Abrir #{aguardandoVoce[0]!.id}
            </Button>
          </Paper>
        )}

        {/* ── Filtros ─────────────────────────────────────────────────────── */}
        <Collapse in={filtersOpen}>
          <Stack spacing={1}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "stretch", md: "center" }}>
              <TextField
                size="small"
                fullWidth
                placeholder="Buscar tarefa…"
                value={filtros.busca}
                onChange={event => updateFiltros({ busca: event.target.value })}
                inputProps={{ "aria-label": "Buscar tarefa", "data-testid": "operation-filter-search" }}
                InputProps={{ startAdornment: <SearchRounded fontSize="small" sx={{ mr: 0.75, color: "text.secondary" }} /> }}
              />
              <FormControl size="small" sx={{ minWidth: 190 }}>
                <InputLabel id="operation-project-label">Projeto</InputLabel>
                <Select
                  labelId="operation-project-label"
                  label="Projeto"
                  value={filtros.projetoId}
                  onChange={event => updateFiltros({ projetoId: event.target.value as number | "" })}
                  data-testid="operation-filter-project"
                >
                  <MenuItem value="">Todos os projetos</MenuItem>
                  {projetos.map(projeto => <MenuItem key={projeto.id} value={projeto.id}>{projeto.nome}</MenuItem>)}
                </Select>
              </FormControl>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {STATUS_FILTERS.map(item => (
                  <Chip
                    key={item.value}
                    size="small"
                    clickable
                    label={item.label}
                    color={filtros.status.includes(item.value) ? "primary" : "default"}
                    variant={filtros.status.includes(item.value) ? "filled" : "outlined"}
                    onClick={() => toggleStatus(item.value)}
                    data-testid={`operation-filter-status-${item.value}`}
                  />
                ))}
                {(["alta", "media", "baixa"] as Prioridade[]).map(level => (
                  <Chip
                    key={level}
                    size="small"
                    clickable
                    label={`Prioridade ${PRIORITY_LABEL[level]}`}
                    color={filtros.prioridade === level ? "primary" : "default"}
                    variant={filtros.prioridade === level ? "filled" : "outlined"}
                    onClick={() => updateFiltros({ prioridade: filtros.prioridade === level ? "" : level })}
                  />
                ))}
              </Stack>
            </Stack>
            {temFiltroAtivo && (
              <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap data-testid="operation-active-filters">
                <Typography variant="caption" color="text.secondary">Filtros:</Typography>
                {filtros.busca && <Chip size="small" label={`Busca: ${filtros.busca}`} onDelete={() => updateFiltros({ busca: "" })} />}
                {filtros.projetoId !== "" && (
                  <Chip size="small" label={`Projeto: ${projetos.find(p => p.id === filtros.projetoId)?.nome ?? filtros.projetoId}`} onDelete={() => updateFiltros({ projetoId: "" })} />
                )}
                {filtros.status.map(value => (
                  <Chip key={value} size="small" label={STATUS_FILTERS.find(item => item.value === value)?.label ?? value} onDelete={() => toggleStatus(value)} />
                ))}
                {filtros.prioridade && <Chip size="small" label={`Prioridade: ${PRIORITY_LABEL[filtros.prioridade as Prioridade]}`} onDelete={() => updateFiltros({ prioridade: "" })} />}
                <Button size="small" onClick={() => setFiltros(EMPTY_FILTERS)}>Limpar filtros</Button>
              </Stack>
            )}
          </Stack>
        </Collapse>

        {/* ── Alternância de visualizações ────────────────────────────────── */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" useFlexGap>
          <Tabs value={view} onChange={(_, value: "mapa" | "lista" | "atividade") => setView(value)} aria-label="Visualizações da operação">
            <Tab value="mapa" label="Mapa da operação" icon={<AccountTreeRounded fontSize="small" />} iconPosition="start" />
            <Tab value="lista" label="Lista" icon={<ViewListRounded fontSize="small" />} iconPosition="start" />
            <Tab value="atividade" label="Atividade" icon={<InsightsRounded fontSize="small" />} iconPosition="start" />
          </Tabs>
          {view === "mapa" && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Tooltip title="Reduzir zoom"><span><IconButton size="small" aria-label="Reduzir zoom" onClick={() => setZoom(z => Math.max(0.6, Number((z - 0.1).toFixed(2))))}><ZoomOutRounded fontSize="small" /></IconButton></span></Tooltip>
              <Typography variant="caption" sx={{ minWidth: 38, textAlign: "center" }} data-testid="operation-zoom-level">{Math.round(zoom * 100)}%</Typography>
              <Tooltip title="Aumentar zoom"><span><IconButton size="small" aria-label="Aumentar zoom" onClick={() => setZoom(z => Math.min(2, Number((z + 0.1).toFixed(2))))}><ZoomInRounded fontSize="small" /></IconButton></span></Tooltip>
              <Tooltip title="Ajustar à tela"><span><IconButton size="small" aria-label="Ajustar à tela" onClick={resetView}><CenterFocusStrongRounded fontSize="small" /></IconButton></span></Tooltip>
            </Stack>
          )}
        </Stack>

        {/* ── MAPA ────────────────────────────────────────────────────────── */}
        {view === "mapa" && (
          <Box
            data-testid="operation-map-rail"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            sx={{
              overflowX: panEnabled ? "hidden" : "auto",
              overflowY: "hidden",
              cursor: panEnabled ? "grab" : "default",
              borderRadius: 1,
            }}
          >
            <Box
              sx={{
                minWidth: { xs: 1180, md: 0 },
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "top left",
                transition: panRef.current ? "none" : "transform 160ms ease",
              }}
            >
              <Stack spacing={1.25} sx={{ pb: 0.5 }}>
                {/* Fluxo principal */}
                <Stack direction="row" alignItems="stretch">
                  {mainRailStations.map((station, index) => (
                    <React.Fragment key={station.id}>
                      <StationNode stationId={station.id} />
                      {index < mainRailStations.length - 1 && <RailLink active={mainActive(station.id)} />}
                    </React.Fragment>
                  ))}
                </Stack>

                {/* Terminal de produção: volume em densidade, sem lista ilimitada */}
                {(() => {
                  const deployadas = porEstacao("deployed")
                  const recentesDeploy = deployadas.slice(0, 3)
                  const pct = deployadas.length ? Math.max(4, Math.round((deployadas.length / Math.max(1, ...[...ALL_STATIONS].map(s => porEstacao(s.id).length))) * 100)) : 0
                  return (
                    <Stack direction="row" spacing={1.25} alignItems="stretch">
                      <Stack alignItems="center" justifyContent="center" spacing={0.25} sx={{ minWidth: 40, color: "success.main" }} aria-hidden="true">
                        <Box sx={{ width: 2, flex: 1, minHeight: 14, borderLeft: "2px dashed", borderColor: "divider" }} />
                        <Typography variant="caption">▼</Typography>
                      </Stack>
                      <Paper variant="outlined" elevation={0} sx={{ p: 1.25, flex: 1, borderLeft: 3, borderLeftColor: "success.main" }} data-testid="operation-deployed-summary">
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }}>
                          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 210 }}>
                            <RocketLaunchRounded sx={{ color: "success.main", fontSize: 20 }} />
                            <Box>
                              <Typography variant="caption" fontWeight={800} textTransform="uppercase" letterSpacing=".05em" display="block">Deployadas</Typography>
                              <Stack direction="row" spacing={0.5} alignItems="baseline">
                                <Typography variant="h6" fontWeight={800} lineHeight={1} data-testid="operation-count-deployed">{deployadas.length}</Typography>
                                <Typography variant="caption" color="text.secondary">em produção</Typography>
                              </Stack>
                            </Box>
                          </Stack>
                          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                            {recentesDeploy.map(task => (
                              <Tooltip key={task.id} arrow title={`#${task.id} ${task.titulo} · ${formatTempoRelativo(task.updatedAt)}`}>
                                <Chip
                                  size="small"
                                  clickable
                                  onClick={() => onSelectTask(task.id)}
                                  icon={<Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "success.main", ml: 1 }} />}
                                  label={`#${task.id} ${task.titulo.slice(0, 22)}`}
                                  sx={{ maxWidth: 200 }}
                                  data-testid={`operation-deployed-recent-${task.id}`}
                                />
                              </Tooltip>
                            ))}
                            {!recentesDeploy.length && <Typography variant="caption" color="text.disabled">nenhuma deployada</Typography>}
                          </Stack>
                          {deployadas.length > 0 && (
                            <Button size="small" endIcon={<ViewListRounded fontSize="small" />} onClick={() => verTodasDaEstacao("deployed")} data-testid="operation-deployed-see-all">
                              Ver todas as {deployadas.length} →
                            </Button>
                          )}
                        </Stack>
                        <Box data-testid="operation-density-deployed" sx={{ mt: 0.75, height: 4, borderRadius: 2, bgcolor: "action.hover", overflow: "hidden" }}>
                          <Box sx={{ height: "100%", width: `${pct}%`, bgcolor: "success.main", borderRadius: 2, transition: "width 240ms ease" }} />
                        </Box>
                      </Paper>
                    </Stack>
                  )
                })()}

                {/* Desvio para exceções */}
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ width: 3, height: 22, borderLeft: "2px dashed", borderColor: "warning.main", ml: 3 }} aria-hidden="true" />
                  <Typography variant="overline" color="text.secondary">desvio · exceções e intervenções</Typography>
                  <Box sx={{ flex: 1, height: 1, bgcolor: "divider" }} />
                </Stack>

                <Stack direction="row" alignItems="stretch">
                  {exceptionStations.map((station, index) => (
                    <React.Fragment key={station.id}>
                      <StationNode stationId={station.id} />
                      {index < exceptionStations.length - 1 && <RailLink active={mainActive(station.id)} />}
                    </React.Fragment>
                  ))}
                </Stack>

                {/* Legenda (não depende só de cor) */}
                <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ pt: 0.5 }}>
                  {(["alta", "media", "baixa"] as Prioridade[]).map(level => (
                    <Stack key={level} direction="row" spacing={0.5} alignItems="center">
                      <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: priorityColor(level) }} />
                      <Typography variant="caption" color="text.secondary">Prioridade {PRIORITY_LABEL[level]}</Typography>
                    </Stack>
                  ))}
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <BoltRounded sx={{ fontSize: 14, color: "primary.main" }} />
                    <Typography variant="caption" color="text.secondary">mais marcadores = mais tarefas (barra de densidade)</Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Box>
          </Box>
        )}

        {/* ── LISTA ───────────────────────────────────────────────────────── */}
        {view === "lista" && (
          <Stack spacing={0.5} data-testid="operation-list-view">
            {stationFocus && (
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" color="primary" label={`Estação: ${stationFocusLabel}`} onDelete={() => setStationFocus("")} />
                <Typography variant="caption" color="text.secondary">{listTasks.length} tarefa{listTasks.length === 1 ? "" : "s"}</Typography>
              </Stack>
            )}
            {listTasks.map(task => (
              <Button
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                data-testid={`operation-list-task-${task.id}`}
                sx={{ justifyContent: "flex-start", textTransform: "none", color: "text.primary", borderBottom: 1, borderColor: "divider", borderRadius: 0, py: 0.75, gap: 1 }}
              >
                <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: priorityColor(deriveTaskPriority(task.status)), flex: "0 0 auto" }} />
                <Typography variant="body2" noWrap sx={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                  #{task.id} {task.titulo}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", sm: "block" } }}>
                  {formatTempoRelativo(task.updatedAt)}
                </Typography>
                <Chip size="small" label={stationOf(task).label} />
              </Button>
            ))}
            {!listTasks.length && (
              <Typography color="text.secondary" sx={{ py: 3, textAlign: "center" }}>Nenhuma tarefa corresponde aos filtros.</Typography>
            )}
          </Stack>
        )}

        {/* ── ATIVIDADE ───────────────────────────────────────────────────── */}
        {view === "atividade" && (
          <Stack spacing={1.5} data-testid="operation-activity-view">
            {deployments.length > 0 && (
              <Box>
                <Typography variant="overline" color="success.main">Deploys em andamento</Typography>
                {deployments.map(deploy => (
                  <Typography key={`${deploy.taskId}-${deploy.startedAt ?? ""}`} variant="body2">
                    #{deploy.taskId} · {deploy.phase ?? "deploy"} · {formatTempoRelativo(deploy.startedAt)}
                  </Typography>
                ))}
              </Box>
            )}
            <Box>
              <Typography variant="overline" color="text.secondary">Últimas mudanças</Typography>
              <Stack spacing={0.25}>
                {recentes.map(task => (
                  <Button
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    data-testid={`operation-activity-task-${task.id}`}
                    sx={{ justifyContent: "flex-start", textTransform: "none", color: "text.primary", borderRadius: 0.5, py: 0.5, gap: 1 }}
                  >
                    <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: toneColor(stationOf(task).tone), flex: "0 0 auto" }} />
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 62 }}>{formatTempoRelativo(task.updatedAt)}</Typography>
                    <Chip size="small" label={stationOf(task).label} />
                    <Typography variant="body2" noWrap sx={{ flex: 1, textAlign: "left", minWidth: 0 }}>#{task.id} {task.titulo}</Typography>
                  </Button>
                ))}
                {!recentes.length && <Typography color="text.secondary" sx={{ py: 2 }}>Nenhuma atividade registrada.</Typography>}
              </Stack>
            </Box>
          </Stack>
        )}
      </Stack>

      {/* ── Popover de workers ──────────────────────────────────────────── */}
      <Popover
        open={Boolean(workersAnchor)}
        anchorEl={workersAnchor}
        onClose={() => setWorkersAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        data-testid="operation-workers-popover"
      >
        <Box sx={{ p: 1.5, minWidth: 260, maxWidth: 360 }}>
          <Typography variant="subtitle2" fontWeight={700}>
            Workers {maxWorkers ? `(${workersAtivos}/${maxWorkers})` : `(${workersAtivos})`}
          </Typography>
          <Divider sx={{ my: 0.75 }} />
          {workers.length ? workers.map(worker => (
            <Stack key={worker.executionId} direction="row" spacing={0.75} alignItems="center" sx={{ py: 0.25 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", flex: "0 0 auto" }} />
              <Typography variant="caption" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {worker.projectSlug ?? "projeto"} · #{worker.taskId}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {worker.executionPhase ?? worker.phase ?? "executando"} · {worker.ageMs != null ? `${Math.max(1, Math.round(worker.ageMs / 60000))}min` : ""}
              </Typography>
            </Stack>
          )) : (
            <Typography variant="caption" color="text.secondary">Nenhum worker ativo no momento.</Typography>
          )}
        </Box>
      </Popover>
    </Paper>
  )
}
