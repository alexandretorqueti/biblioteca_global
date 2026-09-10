import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownwardRounded,
  ArrowForwardRounded,
  ClearRounded,
  ErrorOutlineRounded,
  SearchRounded,
  SettingsRounded,
  VisibilityRounded,
} from "@mui/icons-material"
import { Box, Button, Chip, FormControl, InputLabel, MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography } from "@mui/material"
import { taskStatusLabel } from "../motor-v2/src/shared/task-statuses"
import { deriveTaskPriority, type Prioridade } from "./taskFlowHelpers"

export interface FlowTask {
  id: number
  titulo: string
  descricao?: string | null
  status: string
  projetoId: number
  createdAt?: string | null
  updatedAt?: string | null
  projetoNome?: string | null
  progresso?: { verified: number; total: number } | null
}

export interface MotorActivity {
  taskId: string
  phase: "verify" | "deploy"
}

export interface ProjetoInfo {
  id: number
  nome: string
}

export interface FiltrosMapa {
  busca: string
  status: string[] // slugs: 'em-execucao', 'bloqueadas', 'concluidas'
  projetoId: number | ""
  prioridade: Prioridade | ""
}

interface TaskFlowMapProps {
  tarefas: FlowTask[]
  selectedTaskId: number | ""
  search?: string
  motorActivities?: MotorActivity[]
  onSelectTask: (id: number) => void
  projetos?: ProjetoInfo[]
  filtros?: FiltrosMapa
  onFiltrosChange?: (filtros: FiltrosMapa) => void
}

interface FlowStation {
  id: string
  label: string
  subtitle: string
  statuses: string[]
  tone: "neutral" | "active" | "success" | "warning" | "danger"
}

export const MAIN_FLOW: FlowStation[] = [
  { id: "planning", label: "Planejadas", subtitle: "aguardando análise", statuses: ["planned"], tone: "neutral" },
  { id: "analyzing", label: "Em análise", subtitle: "IA analisando", statuses: ["analyzing"], tone: "active" },
  { id: "ready", label: "Prontas / na fila", subtitle: "próxima subtarefa", statuses: ["ready"], tone: "neutral" },
  { id: "running", label: "Em execução", subtitle: "IA trabalhando", statuses: ["running"], tone: "active" },
  { id: "completed", label: "Concluídas", subtitle: "entregues", statuses: ["completed", "finalizada"], tone: "success" },
  { id: "deployed", label: "Deployadas", subtitle: "em produção", statuses: ["deployed", "deployada"], tone: "success" },
]

export const SIDE_FLOW: FlowStation[] = [
  { id: "waiting", label: "Aguardando", subtitle: "pausa ou resposta humana", statuses: ["awaiting_clarification", "paused"], tone: "warning" },
  { id: "repair", label: "Correção do motor", subtitle: "IA corrigindo o fluxo", statuses: ["motor_fix"], tone: "active" },
  { id: "attention", label: "Atenção", subtitle: "exige intervenção", statuses: ["blocked", "failed"], tone: "danger" },
  { id: "closed", label: "Encerradas", subtitle: "canceladas ou abortadas", statuses: ["cancelled", "aborted"], tone: "neutral" },
]

const ACTIVE_AI_STATUSES = new Set(["analyzing", "running", "motor_fix"])

// Status agrupados para os chips de filtro
const STATUS_CHIP_GROUPS = {
  "em-execucao": { label: "Em execução", statuses: ["running", "analyzing", "motor_fix"] },
  "bloqueadas": { label: "Bloqueadas", statuses: ["blocked", "failed"] },
  "concluidas": { label: "Concluídas", statuses: ["completed", "finalizada", "deployed", "deployada"] },
} as const

// Legenda interativa — mapeia tone para cor e emoji
const LEGENDA_ITEMS = [
  { tone: "success" as const, label: "Sucesso", emoji: "🟢" },
  { tone: "warning" as const, label: "Atenção", emoji: "🟡" },
  { tone: "danger" as const, label: "Perigo", emoji: "🔴" },
  { tone: "active" as const, label: "Ativo", emoji: "🔵" },
] as const

function taskDescription(task: FlowTask): string {
  return typeof task.descricao === "string" && task.descricao.trim()
    ? task.descricao.trim()
    : "Tarefa sem descrição"
}

const TONE_STYLE = {
  neutral: { borderColor: "divider", bgcolor: "action.hover" },
  active: { borderColor: "primary.main", bgcolor: "primary.main", color: "primary.contrastText" },
  success: { borderColor: "success.main", bgcolor: "success.dark", color: "success.contrastText" },
  warning: { borderColor: "warning.main", bgcolor: "warning.dark", color: "warning.contrastText" },
  danger: { borderColor: "error.main", bgcolor: "error.dark", color: "error.contrastText" },
} as const

function Station({ station, tarefas, tarefasFiltradas, selectedTaskId, search, legendaAtiva, movingIds, onSelectTask, taskMatchesLegenda }: {
  station: FlowStation
  tarefas: FlowTask[]
  tarefasFiltradas: FlowTask[]
  selectedTaskId: number | ""
  search: string
  legendaAtiva: FlowStation["tone"] | null
  movingIds: Set<number>
  onSelectTask: (id: number) => void
  taskMatchesLegenda: (task: FlowTask, station: FlowStation) => boolean
}) {
  const stationTasks = tarefas.filter((task) => station.statuses.includes(task.status))
  // Tarefas da estação que passam nos filtros
  const stationTasksFiltradas = tarefasFiltradas.filter((task) => station.statuses.includes(task.status))
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR")
  const visibleTasks = stationTasksFiltradas
    .filter((task) => !normalizedSearch || `#${task.id} ${task.titulo}`.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
    .slice(0, 3)

  return (
    <Paper
      variant="outlined"
      data-testid={`flow-station-${station.id}`}
      sx={{ ...TONE_STYLE[station.tone], p: 1.5, minWidth: 190, minHeight: 196, borderWidth: 1.5, borderRadius: 3, transition: "box-shadow 120ms ease, transform 120ms ease" }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box>
          <Typography fontWeight={750}>{station.label}</Typography>
          <Typography variant="caption" sx={{ opacity: 0.78 }}>{station.subtitle}</Typography>
        </Box>
        <Typography variant="h5" fontWeight={800} data-testid={`flow-count-${station.id}`}>{stationTasks.length}</Typography>
      </Stack>
      {station.statuses.length > 1 && (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          {station.statuses.map((status) => (
            <Chip key={status} size="small" label={`${taskStatusLabel(status)}: ${stationTasks.filter((task) => task.status === status).length}`} sx={{ height: 20, fontSize: 10 }} />
          ))}
        </Stack>
      )}
      <Stack spacing={0.75} sx={{ mt: 1.25 }}>
        {visibleTasks.map((task) => {
          const aiActive = ACTIVE_AI_STATUSES.has(task.status)
          const matchesLegenda = taskMatchesLegenda(task, station)
          return (
            <Paper
              key={task.id}
              component="button"
              type="button"
              onClick={() => onSelectTask(task.id)}
              data-testid={`flow-task-${task.id}`}
              aria-label={`Abrir tarefa ${task.id}: ${task.titulo}`}
              elevation={task.id === selectedTaskId ? 5 : 0}
              sx={{
                width: "100%", p: 0.8, border: 0, borderLeft: 3, borderColor: task.id === selectedTaskId ? "secondary.main" : "transparent",
                textAlign: "left", cursor: "pointer", bgcolor: "background.paper", color: "text.primary",
                animation: movingIds.has(task.id) ? "task-arrived 1.1s ease-in-out 3" : undefined,
                opacity: matchesLegenda ? 1 : 0.25,
                transition: "opacity 200ms ease",
                "&:hover": { transform: "translateY(-1px)", boxShadow: 2 },
                "@keyframes task-arrived": { "0%, 100%": { opacity: 1 }, "50%": { opacity: 0.45 } },
              }}
            >
              <Stack direction="row" spacing={0.7} alignItems="center" sx={{ minWidth: 0 }}>
                {aiActive && <SettingsRounded aria-label="IA trabalhando" sx={{ flexShrink: 0, fontSize: 18, color: "warning.main", animation: "gear-spin 2s linear infinite", "@keyframes gear-spin": { to: { transform: "rotate(360deg)" } } }} />}
                {station.tone === "danger" && <ErrorOutlineRounded sx={{ flexShrink: 0, fontSize: 17, color: "error.main" }} />}
                <Typography variant="caption" fontWeight={700} noWrap sx={{ minWidth: 0, flex: 1 }}>#{task.id} {task.titulo}</Typography>
                <Tooltip title={taskDescription(task)} arrow placement="top">
                  <Box
                    component="span"
                    aria-label={`Descrição da tarefa ${task.id}`}
                    data-testid={`flow-task-description-${task.id}`}
                    sx={{ display: "inline-flex", flexShrink: 0, color: "action.active", cursor: "help" }}
                  >
                    <VisibilityRounded sx={{ fontSize: 16 }} />
                  </Box>
                </Tooltip>
              </Stack>
            </Paper>
          )
        })}
        {normalizedSearch && stationTasks.length > 0 && visibleTasks.length === 0 && <Typography variant="caption" sx={{ opacity: 0.65 }}>Nenhuma correspondência</Typography>}
        {!normalizedSearch && stationTasks.length > visibleTasks.length && <Typography variant="caption" textAlign="center" sx={{ opacity: 0.72 }}>+ {stationTasks.length - visibleTasks.length} tarefas</Typography>}
      </Stack>
    </Paper>
  )
}

export default function TaskFlowMap({ tarefas, selectedTaskId, search = "", motorActivities = [], onSelectTask, projetos = [], filtros: filtrosExternos, onFiltrosChange }: TaskFlowMapProps) {
  const previousStatuses = useRef(new Map<number, string>())
  const [movements, setMovements] = useState<Array<{ id: number; from: string; to: string }>>([])
  const [legendaAtiva, setLegendaAtiva] = useState<FlowStation["tone"] | null>(null)

  // Filtros internos (usados quando não há filtrosExternos)
  const [filtrosInternos, setFiltrosInternos] = useState<FiltrosMapa>({
    busca: "",
    status: [],
    projetoId: "",
    prioridade: "",
  })

  // Usa filtros externos se fornecidos, senão internos
  const filtros = filtrosExternos ?? filtrosInternos
  const setFiltros = onFiltrosChange ?? setFiltrosInternos

  // Verifica se há algum filtro ativo
  const hasFiltrosAtivos = useMemo(() => {
    return filtros.busca.trim() !== "" ||
      filtros.status.length > 0 ||
      filtros.projetoId !== "" ||
      filtros.prioridade !== "" ||
      legendaAtiva !== null
  }, [filtros, legendaAtiva])

  // Limpa todos os filtros
  const limparFiltros = useCallback(() => {
    setFiltros({ busca: "", status: [], projetoId: "", prioridade: "" })
    setLegendaAtiva(null)
  }, [setFiltros])

  // Handler de teclado: Esc limpa filtros
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && hasFiltrosAtivos) {
        e.preventDefault()
        limparFiltros()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [hasFiltrosAtivos, limparFiltros])

  // Toggle de chip de status
  const toggleStatusChip = useCallback((slug: string) => {
    setFiltros({
      ...filtros,
      status: filtros.status.includes(slug)
        ? filtros.status.filter((s) => s !== slug)
        : [...filtros.status, slug],
    })
  }, [filtros, setFiltros])

  // Toggle de legenda
  const toggleLegenda = useCallback((tone: FlowStation["tone"]) => {
    setLegendaAtiva((atual) => (atual === tone ? null : tone))
  }, [])

  useEffect(() => {
    const next = new Map(tarefas.map((task) => [task.id, task.status]))
    const changed = tarefas.flatMap((task) => {
      const previous = previousStatuses.current.get(task.id)
      return previous && previous !== task.status ? [{ id: task.id, from: previous, to: task.status }] : []
    })
    previousStatuses.current = next
    if (changed.length === 0) return
    setMovements(changed)
    const timeout = window.setTimeout(() => setMovements([]), 5000)
    return () => window.clearTimeout(timeout)
  }, [tarefas])

  const movingIds = useMemo(() => new Set(movements.map((movement) => movement.id)), [movements])
  const activeAiCount = useMemo(() => tarefas.filter((task) => ACTIVE_AI_STATUSES.has(task.status)).length, [tarefas])

  // Filtra tarefas baseado nos filtros ativos
  const tarefasFiltradas = useMemo(() => {
    return tarefas.filter((task) => {
      // Filtro de busca
      if (filtros.busca.trim()) {
        const normalizedBusca = filtros.busca.trim().toLocaleLowerCase("pt-BR")
        const matchBusca = `#${task.id} ${task.titulo}`.toLocaleLowerCase("pt-BR").includes(normalizedBusca)
        if (!matchBusca) return false
      }

      // Filtro de status (chips)
      if (filtros.status.length > 0) {
        const statusesAtivas = filtros.status.flatMap((slug) => STATUS_CHIP_GROUPS[slug as keyof typeof STATUS_CHIP_GROUPS]?.statuses ?? [])
        if (!statusesAtivas.includes(task.status)) return false
      }

      // Filtro de projeto
      if (filtros.projetoId !== "" && task.projetoId !== filtros.projetoId) return false

      // Filtro de prioridade
      if (filtros.prioridade !== "") {
        const prioridadeTask = deriveTaskPriority(task.status)
        if (prioridadeTask !== filtros.prioridade) return false
      }

      return true
    })
  }, [tarefas, filtros])

  // Contador de tarefas filtradas
  const contadorFiltro = `${tarefasFiltradas.length} de ${tarefas.length} tarefas`

  // Verifica se uma tarefa corresponde ao tone da legenda ativa
  const taskMatchesLegenda = useCallback((task: FlowTask, station: FlowStation) => {
    if (!legendaAtiva) return true
    return station.tone === legendaAtiva
  }, [legendaAtiva])

  return (
    <Paper
      variant="outlined"
      sx={{
        width: "100%",
        p: { xs: 1.5, md: 2 },
        overflow: "hidden",
        boxSizing: "border-box",
      }}
      data-testid="task-flow-map"
    >
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} sx={{ mb: 2 }}>
        <Box><Typography variant="h6" fontWeight={750}>Mapa Vivo da Operação</Typography><Typography variant="body2" color="text.secondary">Acompanhe as tarefas percorrendo o fluxo em tempo real.</Typography></Box>
        <Stack direction="row" spacing={1} alignItems="center" data-testid="flow-ai-activity"><SettingsRounded sx={{ color: activeAiCount ? "warning.main" : "text.disabled", animation: activeAiCount ? "legend-spin 2s linear infinite" : "none", "@keyframes legend-spin": { to: { transform: "rotate(360deg)" } } }} /><Typography variant="caption" color="text.secondary">{activeAiCount ? `IA trabalhando (${activeAiCount})` : "Nenhuma IA trabalhando"}</Typography></Stack>
      </Stack>

      {/* Barra de filtro integrada ao topo */}
      <Paper
        variant="outlined"
        sx={{ p: 1.5, mb: 2, bgcolor: "action.hover", borderRadius: 2 }}
        data-testid="map-filter-bar"
      >
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          {/* Busca */}
          <TextField
            size="small"
            placeholder="Buscar tarefa..."
            value={filtros.busca}
            onChange={(e) => setFiltros({ ...filtros, busca: e.target.value })}
            inputProps={{ "data-testid": "map-filter-busca" }}
            InputProps={{ startAdornment: <SearchRounded sx={{ mr: 0.5, color: "text.secondary", fontSize: 20 }} /> }}
            sx={{ minWidth: 200, flex: 1 }}
          />

          {/* Chips de status */}
          {Object.entries(STATUS_CHIP_GROUPS).map(([slug, group]) => (
            <Chip
              key={slug}
              label={group.label}
              onClick={() => toggleStatusChip(slug)}
              color={filtros.status.includes(slug) ? "primary" : "default"}
              variant={filtros.status.includes(slug) ? "filled" : "outlined"}
              data-testid={`map-filter-chip-${slug}`}
              sx={{ cursor: "pointer" }}
            />
          ))}

          {/* Projeto */}
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Projeto</InputLabel>
            <Select
              label="Projeto"
              value={filtros.projetoId}
              onChange={(e) => setFiltros({ ...filtros, projetoId: e.target.value as number | "" })}
              data-testid="map-filter-projeto"
            >
              <MenuItem value="">Todos</MenuItem>
              {projetos.map((p) => (
                <MenuItem key={p.id} value={p.id}>{p.nome}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Prioridade */}
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" sx={{ mr: 0.5 }}>Prioridade:</Typography>
            {(["alta", "media", "baixa"] as const).map((nivel) => (
              <Chip
                key={nivel}
                label={nivel === "alta" ? "Alta" : nivel === "media" ? "Média" : "Baixa"}
                size="small"
                onClick={() => setFiltros({ ...filtros, prioridade: filtros.prioridade === nivel ? "" : nivel })}
                color={filtros.prioridade === nivel
                  ? (nivel === "alta" ? "error" : nivel === "media" ? "warning" : "success")
                  : "default"}
                variant={filtros.prioridade === nivel ? "filled" : "outlined"}
                data-testid={`map-filter-prioridade-${nivel}`}
                sx={{ cursor: "pointer", minWidth: 50 }}
              />
            ))}
          </Stack>

          {/* Contador */}
          <Typography variant="caption" color="text.secondary" data-testid="map-filter-contador" sx={{ ml: "auto" }}>
            {contadorFiltro}
          </Typography>

          {/* Botão limpar filtros */}
          {hasFiltrosAtivos && (
            <Button
              size="small"
              startIcon={<ClearRounded />}
              onClick={limparFiltros}
              data-testid="map-filter-limpar"
              sx={{ minWidth: "auto" }}
            >
              Limpar
            </Button>
          )}
        </Stack>
      </Paper>

      <Stack direction="row" spacing={1} alignItems="center" data-testid="flow-motor-activity" sx={{ mb: 2 }}>
        <SettingsRounded sx={{ color: motorActivities.length ? "info.main" : "text.disabled", animation: motorActivities.length ? "motor-gear-spin 2s linear infinite" : "none", "@keyframes motor-gear-spin": { to: { transform: "rotate(360deg)" } } }} />
        <Typography variant="caption" color="text.secondary">
          {motorActivities.length
            ? motorActivities.map((activity) => `${activity.phase === "verify" ? "verificando" : "deployando"} ${activity.taskId}`).join(" · ")
            : "Motor sem verificações ou deploys"}
        </Typography>
      </Stack>

      {movements.map((movement) => <Chip key={movement.id} color="info" sx={{ mb: 1.5, mr: 1 }} label={`#${movement.id} · ${taskStatusLabel(movement.from)} → ${taskStatusLabel(movement.to)}`} data-testid={`flow-movement-${movement.id}`} />)}

      <Box sx={{ overflowX: "auto", pb: 1 }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="center"
          flexWrap="wrap"
          useFlexGap
          spacing={0.75}
          sx={{ width: "100%" }}
        >
          {MAIN_FLOW.map((station, index) => (
            <React.Fragment key={station.id}>
              <Station
                station={station}
                tarefas={tarefas}
                tarefasFiltradas={tarefasFiltradas}
                selectedTaskId={selectedTaskId}
                search={search}
                legendaAtiva={legendaAtiva}
                movingIds={movingIds}
                onSelectTask={onSelectTask}
                taskMatchesLegenda={taskMatchesLegenda}
              />
              {index < MAIN_FLOW.length - 1 && <ArrowForwardRounded color="action" aria-hidden="true" />}
            </React.Fragment>
          ))}
        </Stack>
        <Stack alignItems="center" sx={{ width: "100%", my: 0.5 }}><ArrowDownwardRounded color="action" /></Stack>
        <Stack
          direction="row"
          justifyContent="center"
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          spacing={1}
          sx={{ width: "100%" }}
        >
          {SIDE_FLOW.map((station, index) => (
            <React.Fragment key={station.id}>
              <Station
                station={station}
                tarefas={tarefas}
                tarefasFiltradas={tarefasFiltradas}
                selectedTaskId={selectedTaskId}
                search={search}
                legendaAtiva={legendaAtiva}
                movingIds={movingIds}
                onSelectTask={onSelectTask}
                taskMatchesLegenda={taskMatchesLegenda}
              />
              {index < SIDE_FLOW.length - 1 && <ArrowForwardRounded color="action" aria-hidden="true" />}
            </React.Fragment>
          ))}
        </Stack>
      </Box>

      {/* Legenda interativa no rodapé */}
      <Stack
        direction="row"
        spacing={2}
        justifyContent="center"
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ mt: 2, pt: 1.5, borderTop: "1px solid", borderColor: "divider" }}
        data-testid="map-legend"
      >
        {LEGENDA_ITEMS.map((item) => (
          <Chip
            key={item.tone}
            label={`${item.emoji} ${item.label}`}
            onClick={() => toggleLegenda(item.tone)}
            color={legendaAtiva === item.tone ? "primary" : "default"}
            variant={legendaAtiva === item.tone ? "filled" : "outlined"}
            data-testid={`map-legend-${item.tone}`}
            sx={{ cursor: "pointer" }}
          />
        ))}
      </Stack>
    </Paper>
  )
}
