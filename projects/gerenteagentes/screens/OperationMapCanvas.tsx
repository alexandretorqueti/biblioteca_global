import React, { useMemo, useState } from "react"
import {
  AccountTreeRounded,
  BuildRounded,
  CheckCircleRounded,
  ContentPasteRounded,
  EditNoteRounded,
  FilterAltRounded,
  HourglassBottomRounded,
  PauseCircleRounded,
  RocketLaunchRounded,
  SearchRounded,
  SettingsRounded,
  WarningAmberRounded,
} from "@mui/icons-material"
import {
  Box,
  Button,
  Chip,
  Collapse,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material"
import { deriveTaskPriority, type Prioridade } from "./taskFlowHelpers"
import type { FiltrosMapa, FlowTask, MotorActivity } from "./TaskFlowMap"

type StationTone = "neutral" | "active" | "success" | "warning" | "danger"
type Station = { id: string; label: string; description: string; statuses: string[]; tone: StationTone }

const MAIN_STATIONS: Station[] = [
  { id: "draft", label: "Rascunhos", description: "não iniciadas", statuses: ["draft"], tone: "neutral" },
  { id: "planned", label: "Planejadas", description: "aguardando análise", statuses: ["planned"], tone: "neutral" },
  { id: "analyzing", label: "Em análise", description: "IA analisando", statuses: ["analyzing"], tone: "active" },
  { id: "ready", label: "Fila de execução", description: "próximas subtarefas", statuses: ["ready"], tone: "neutral" },
  { id: "running", label: "Em execução", description: "IA trabalhando", statuses: ["running"], tone: "active" },
  { id: "completed", label: "Concluídas", description: "entregues", statuses: ["completed", "finalizada"], tone: "success" },
  { id: "deployed", label: "Deployadas", description: "em produção", statuses: ["deployed", "deployada"], tone: "success" },
]
const EXCEPTION_STATIONS: Station[] = [
  { id: "waiting", label: "Aguardando", description: "resposta humana", statuses: ["awaiting_clarification", "paused"], tone: "warning" },
  { id: "repair", label: "Correção do motor", description: "motor corrigindo", statuses: ["motor_fix"], tone: "active" },
  { id: "attention", label: "Atenção", description: "intervenção necessária", statuses: ["blocked", "failed"], tone: "danger" },
  { id: "closed", label: "Encerradas", description: "canceladas ou abortadas", statuses: ["cancelled", "aborted"], tone: "neutral" },
]
const ALL_STATIONS = [...MAIN_STATIONS, ...EXCEPTION_STATIONS]
const STATUS_FILTERS = [
  { value: "active", label: "Em execução", statuses: ["running", "analyzing", "motor_fix"] },
  { value: "attention", label: "Atenção", statuses: ["blocked", "failed", "awaiting_clarification"] },
  { value: "done", label: "Concluídas", statuses: ["completed", "finalizada", "deployed", "deployada"] },
]
const ICONS: Record<string, React.ComponentType<{ sx?: object }>> = {
  draft: EditNoteRounded, planned: ContentPasteRounded, analyzing: SearchRounded, ready: HourglassBottomRounded,
  running: SettingsRounded, completed: CheckCircleRounded, deployed: RocketLaunchRounded, waiting: PauseCircleRounded,
  repair: BuildRounded, attention: WarningAmberRounded, closed: CheckCircleRounded,
}

const toneColor = (tone: StationTone): "text.disabled" | "primary.main" | "success.main" | "warning.main" | "error.main" => ({
  neutral: "text.disabled", active: "primary.main", success: "success.main", warning: "warning.main", danger: "error.main",
}[tone])

const EMPTY_FILTERS: FiltrosMapa = { busca: "", status: [], projetoId: "", prioridade: "" }

export interface OperationMapCanvasProps {
  tarefas: FlowTask[]
  selectedTaskId: number | ""
  projetos: Array<{ id: number; nome: string }>
  motorActivities?: MotorActivity[]
  filtros?: FiltrosMapa
  onFiltrosChange?: (filters: FiltrosMapa) => void
  onSelectTask: (id: number) => void
}

export default function OperationMapCanvas({ tarefas, selectedTaskId, projetos, motorActivities = [], filtros: externalFilters, onFiltrosChange, onSelectTask }: OperationMapCanvasProps) {
  const [internalFilters, setInternalFilters] = useState(EMPTY_FILTERS)
  const [view, setView] = useState<"map" | "list">("map")
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const filters = externalFilters ?? internalFilters
  const setFilters = onFiltrosChange ?? setInternalFilters
  const filtered = useMemo(() => tarefas.filter(task => {
    const query = filters.busca.trim().toLocaleLowerCase("pt-BR")
    if (query && !(`#${task.id} ${task.titulo}`).toLocaleLowerCase("pt-BR").includes(query)) return false
    if (filters.projetoId !== "" && task.projetoId !== filters.projetoId) return false
    if (filters.prioridade && deriveTaskPriority(task.status) !== filters.prioridade) return false
    if (filters.status.length && !filters.status.flatMap(value => STATUS_FILTERS.find(item => item.value === value)?.statuses ?? []).includes(task.status)) return false
    return true
  }), [tarefas, filters])
  const activeFilters = filters.busca || filters.projetoId !== "" || filters.prioridade || filters.status.length > 0
  const taskStation = (task: FlowTask) => ALL_STATIONS.find(station => station.statuses.includes(task.status)) ?? EXCEPTION_STATIONS[2]
  const byStation = (station: Station) => filtered.filter(task => station.statuses.includes(task.status))
  const updateFilters = (next: Partial<FiltrosMapa>) => setFilters({ ...filters, ...next })
  const toggleStatus = (value: string) => updateFilters({ status: filters.status.includes(value) ? filters.status.filter(item => item !== value) : [...filters.status, value] })
  const activityCount = new Set(motorActivities.map(activity => activity.taskId)).size

  const Marker = ({ task, station }: { task: FlowTask; station: Station }) => {
    const selected = task.id === selectedTaskId
    const priority = deriveTaskPriority(task.status)
    const priorityColor: Record<Prioridade, "error.main" | "warning.main" | "success.main"> = { alta: "error.main", media: "warning.main", baixa: "success.main" }
    return <Tooltip title={<Box><Typography variant="caption" display="block" fontWeight={700}>#{task.id} {task.titulo}</Typography><Typography variant="caption" display="block">{station.label} · Projeto {task.projetoNome ?? task.projetoId}</Typography></Box>} arrow>
      <IconButton size="small" onClick={() => onSelectTask(task.id)} aria-label={`Abrir tarefa ${task.id}: ${task.titulo}`} data-testid={`operation-map-task-${task.id}`} sx={{ p: 0.35, color: priorityColor[priority], border: selected ? 2 : 0, borderColor: "primary.main", borderRadius: "50%", '&:hover': { bgcolor: "action.hover" } }}>
        <Box sx={{ width: 12, height: 12, borderRadius: "50%", bgcolor: "currentColor", boxShadow: station.tone === "active" ? "0 0 0 3px color-mix(in srgb, currentColor 18%, transparent)" : undefined }} />
      </IconButton>
    </Tooltip>
  }

  const StationNode = ({ station }: { station: Station }) => {
    const stationTasks = byStation(station)
    const allStationTasks = tarefas.filter(task => station.statuses.includes(task.status))
    const isExpanded = expanded.has(station.id)
    const visible = isExpanded ? stationTasks : stationTasks.slice(0, 5)
    const Icon = ICONS[station.id]
    return <Paper variant="outlined" data-testid={`operation-station-${station.id}`} sx={{ minWidth: { xs: 170, md: 190 }, flex: "1 1 0", p: 1.25, borderTop: 2, borderTopColor: toneColor(station.tone), bgcolor: stationTasks.length ? "background.paper" : "action.hover", transition: "border-color 180ms ease" }}>
      <Stack direction="row" spacing={1} alignItems="flex-start"><Icon sx={{ color: toneColor(station.tone), fontSize: 21 }} /><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="caption" fontWeight={800} textTransform="uppercase" letterSpacing=".04em" noWrap>{station.label}</Typography><Typography variant="caption" color="text.secondary" display="block" noWrap>{station.description}</Typography></Box><Typography variant="h6" fontWeight={800} lineHeight={1} data-testid={`operation-count-${station.id}`}>{allStationTasks.length}</Typography></Stack>
      <Box sx={{ minHeight: 31, mt: 1, display: "flex", gap: .25, alignItems: "center", flexWrap: "wrap" }}>{visible.map(task => <Marker key={task.id} task={task} station={station} />)}{!stationTasks.length && <Typography variant="caption" color="text.disabled">vazio</Typography>}{stationTasks.length > 5 && <Button size="small" onClick={() => setExpanded(old => { const next = new Set(old); if (isExpanded) next.delete(station.id); else next.add(station.id); return next })} sx={{ minWidth: 0, p: 0, fontSize: 11 }}>+{isExpanded ? " recolher" : ` ${stationTasks.length - 5}`}</Button>}</Box>
    </Paper>
  }

  return <Paper variant="outlined" data-testid="operation-map-canvas" sx={{ overflow: "hidden" }}>
    <Stack spacing={1.5} sx={{ p: { xs: 1.5, md: 2 } }}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", md: "center" }} spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center"><AccountTreeRounded color="primary" /><Box><Typography variant="h6" fontWeight={800}>Mapa da operação</Typography><Typography variant="body2" color="text.secondary">Fluxo vivo de tarefas e intervenções</Typography></Box></Stack>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap><Typography variant="caption" color="text.secondary">{filtered.length} de {tarefas.length} tarefas</Typography><Typography variant="caption" color={activityCount ? "primary.main" : "text.secondary"}>● {activityCount} em atividade</Typography><Button size="small" startIcon={<FilterAltRounded />} onClick={() => setFiltersOpen(open => !open)}>{activeFilters ? "Filtros ativos" : "Filtros"}</Button></Stack>
      </Stack>
      <Collapse in={filtersOpen}><Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "stretch", md: "center" }}>
        <TextField size="small" fullWidth placeholder="Buscar tarefa…" value={filters.busca} onChange={event => updateFilters({ busca: event.target.value })} InputProps={{ startAdornment: <SearchRounded fontSize="small" sx={{ mr: .75, color: "text.secondary" }} /> }} inputProps={{ "aria-label": "Buscar tarefa" }} />
        <FormControl size="small" sx={{ minWidth: 180 }}><InputLabel>Projeto</InputLabel><Select label="Projeto" value={filters.projetoId} onChange={event => updateFilters({ projetoId: event.target.value as number | "" })}><MenuItem value="">Todos os projetos</MenuItem>{projetos.map(project => <MenuItem key={project.id} value={project.id}>{project.nome}</MenuItem>)}</Select></FormControl>
        <Stack direction="row" spacing={.5} flexWrap="wrap" useFlexGap>{STATUS_FILTERS.map(item => <Chip key={item.value} size="small" label={item.label} clickable color={filters.status.includes(item.value) ? "primary" : "default"} variant={filters.status.includes(item.value) ? "filled" : "outlined"} onClick={() => toggleStatus(item.value)} />)}{(["alta", "media", "baixa"] as Prioridade[]).map(level => <Chip key={level} size="small" label={`Prioridade ${level}`} clickable color={filters.prioridade === level ? "primary" : "default"} variant={filters.prioridade === level ? "filled" : "outlined"} onClick={() => updateFilters({ prioridade: filters.prioridade === level ? "" : level })} />)}</Stack>
      </Stack></Collapse>
      <Stack direction="row" justifyContent="space-between" alignItems="center"><Tabs value={view} onChange={(_, value) => setView(value)} aria-label="Visualização da operação"><Tab value="map" label="Mapa da operação" /><Tab value="list" label="Lista" /></Tabs>{activeFilters && <Button size="small" onClick={() => setFilters(EMPTY_FILTERS)}>Limpar filtros</Button>}</Stack>
      {view === "map" ? <Stack spacing={1.5} sx={{ pb: .5 }}><Stack direction="row" alignItems="stretch" spacing={.75} sx={{ flexWrap: "wrap", gap: { xs: 1, md: 0.75 } }}>{MAIN_STATIONS.map((station, index) => <React.Fragment key={station.id}><Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, flex: "0 1 auto" }}><StationNode station={station} />{index < MAIN_STATIONS.length - 1 && <Box sx={{ color: "divider", fontSize: 20, flexShrink: 0 }} aria-hidden="true">→</Box>}</Box></React.Fragment>)}</Stack><Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap" }}><Typography variant="overline" color="text.secondary" sx={{ minWidth: 150 }}>Exceções / intervenções</Typography><Box sx={{ height: 1, bgcolor: "divider", flex: 1, minWidth: 100 }} /></Stack><Stack direction="row" alignItems="stretch" spacing={.75} sx={{ flexWrap: "wrap", gap: { xs: 1, md: 0.75 } }}>{EXCEPTION_STATIONS.map((station, index) => <React.Fragment key={station.id}><Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, flex: "0 1 auto" }}><StationNode station={station} />{index < EXCEPTION_STATIONS.length - 1 && <Box sx={{ color: "divider", fontSize: 20, flexShrink: 0 }} aria-hidden="true">→</Box>}</Box></React.Fragment>)}</Stack></Stack> : <Stack spacing={.5}>{filtered.map(task => <Button key={task.id} onClick={() => onSelectTask(task.id)} sx={{ justifyContent: "flex-start", textTransform: "none", color: "text.primary", borderBottom: 1, borderColor: "divider", borderRadius: 0, py: .75 }}><Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: "primary.main", mr: 1 }} /><Typography variant="body2" noWrap sx={{ flex: 1, textAlign: "left" }}>#{task.id} {task.titulo}</Typography><Chip size="small" label={taskStation(task).label} /></Button>)}{!filtered.length && <Typography color="text.secondary" sx={{ py: 3, textAlign: "center" }}>Nenhuma tarefa corresponde aos filtros.</Typography>}</Stack>}
    </Stack>
  </Paper>
}
