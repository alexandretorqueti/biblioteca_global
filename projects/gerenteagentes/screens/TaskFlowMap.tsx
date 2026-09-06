import React, { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDownwardRounded,
  ArrowForwardRounded,
  ErrorOutlineRounded,
  SettingsRounded,
} from "@mui/icons-material"
import { Box, Chip, Paper, Stack, Typography } from "@mui/material"
import { taskStatusLabel } from "../motor-v2/src/shared/task-statuses"

export interface FlowTask {
  id: number
  titulo: string
  status: string
  projetoId: number
}

interface TaskFlowMapProps {
  tarefas: FlowTask[]
  selectedTaskId: number | ""
  search?: string
  onSelectTask: (id: number) => void
}

interface FlowStation {
  id: string
  label: string
  subtitle: string
  statuses: string[]
  tone: "neutral" | "active" | "success" | "warning" | "danger"
}

const MAIN_FLOW: FlowStation[] = [
  { id: "draft", label: "Rascunhos", subtitle: "em preparação", statuses: ["draft"], tone: "neutral" },
  { id: "planning", label: "Planejadas", subtitle: "aguardando análise", statuses: ["planned"], tone: "neutral" },
  { id: "analyzing", label: "Em análise", subtitle: "IA analisando", statuses: ["analyzing"], tone: "active" },
  { id: "ready", label: "Prontas / na fila", subtitle: "próxima subtarefa", statuses: ["ready"], tone: "neutral" },
  { id: "running", label: "Em execução", subtitle: "IA trabalhando", statuses: ["running"], tone: "active" },
  { id: "completed", label: "Concluídas", subtitle: "entregues", statuses: ["completed", "finalizada"], tone: "success" },
  { id: "deployed", label: "Deployadas", subtitle: "em produção", statuses: ["deployed", "deployada"], tone: "success" },
]

const SIDE_FLOW: FlowStation[] = [
  { id: "waiting", label: "Aguardando", subtitle: "pausa ou resposta humana", statuses: ["awaiting_clarification", "paused"], tone: "warning" },
  { id: "repair", label: "Correção do motor", subtitle: "IA corrigindo o fluxo", statuses: ["motor_fix"], tone: "active" },
  { id: "attention", label: "Atenção", subtitle: "exige intervenção", statuses: ["blocked", "failed"], tone: "danger" },
  { id: "closed", label: "Encerradas", subtitle: "canceladas ou abortadas", statuses: ["cancelled", "aborted"], tone: "neutral" },
]

const ACTIVE_AI_STATUSES = new Set(["analyzing", "running", "motor_fix"])

const TONE_STYLE = {
  neutral: { borderColor: "divider", bgcolor: "action.hover" },
  active: { borderColor: "primary.main", bgcolor: "primary.main", color: "primary.contrastText" },
  success: { borderColor: "success.main", bgcolor: "success.dark", color: "success.contrastText" },
  warning: { borderColor: "warning.main", bgcolor: "warning.dark", color: "warning.contrastText" },
  danger: { borderColor: "error.main", bgcolor: "error.dark", color: "error.contrastText" },
} as const

function Station({ station, tarefas, selectedTaskId, search, movingIds, onSelectTask }: {
  station: FlowStation
  tarefas: FlowTask[]
  selectedTaskId: number | ""
  search: string
  movingIds: Set<number>
  onSelectTask: (id: number) => void
}) {
  const stationTasks = tarefas.filter((task) => station.statuses.includes(task.status))
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR")
  const visibleTasks = stationTasks
    .filter((task) => !normalizedSearch || `#${task.id} ${task.titulo}`.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
    .slice(0, 3)

  return (
    <Paper
      variant="outlined"
      data-testid={`flow-station-${station.id}`}
      sx={{ ...TONE_STYLE[station.tone], p: 1.5, minWidth: 190, minHeight: 196, borderWidth: 1.5, borderRadius: 3 }}
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
                "&:hover": { transform: "translateY(-1px)", boxShadow: 2 },
                "@keyframes task-arrived": { "0%, 100%": { opacity: 1 }, "50%": { opacity: 0.45 } },
              }}
            >
              <Stack direction="row" spacing={0.7} alignItems="center">
                {aiActive && <SettingsRounded aria-label="IA trabalhando" sx={{ fontSize: 18, color: "warning.main", animation: "gear-spin 2s linear infinite", "@keyframes gear-spin": { to: { transform: "rotate(360deg)" } } }} />}
                {station.tone === "danger" && <ErrorOutlineRounded sx={{ fontSize: 17, color: "error.main" }} />}
                <Typography variant="caption" fontWeight={700} noWrap>#{task.id} {task.titulo}</Typography>
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

export default function TaskFlowMap({ tarefas, selectedTaskId, search = "", onSelectTask }: TaskFlowMapProps) {
  const previousStatuses = useRef(new Map<number, string>())
  const [movements, setMovements] = useState<Array<{ id: number; from: string; to: string }>>([])

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

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2 }, overflow: "hidden" }} data-testid="task-flow-map">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} sx={{ mb: 2 }}>
        <Box><Typography variant="h6" fontWeight={750}>Mapa Vivo da Operação</Typography><Typography variant="body2" color="text.secondary">Acompanhe as tarefas percorrendo o fluxo em tempo real.</Typography></Box>
        <Stack direction="row" spacing={1} alignItems="center" data-testid="flow-ai-activity"><SettingsRounded sx={{ color: activeAiCount ? "warning.main" : "text.disabled", animation: activeAiCount ? "legend-spin 2s linear infinite" : "none", "@keyframes legend-spin": { to: { transform: "rotate(360deg)" } } }} /><Typography variant="caption" color="text.secondary">{activeAiCount ? `IA trabalhando (${activeAiCount})` : "Nenhuma IA trabalhando"}</Typography></Stack>
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
          {MAIN_FLOW.map((station, index) => <React.Fragment key={station.id}><Station station={station} tarefas={tarefas} selectedTaskId={selectedTaskId} search={search} movingIds={movingIds} onSelectTask={onSelectTask} />{index < MAIN_FLOW.length - 1 && <ArrowForwardRounded color="action" aria-hidden="true" />}</React.Fragment>)}
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
          {SIDE_FLOW.map((station, index) => <React.Fragment key={station.id}><Station station={station} tarefas={tarefas} selectedTaskId={selectedTaskId} search={search} movingIds={movingIds} onSelectTask={onSelectTask} />{index < SIDE_FLOW.length - 1 && <ArrowForwardRounded color="action" aria-hidden="true" />}</React.Fragment>)}
        </Stack>
      </Box>
    </Paper>
  )
}
