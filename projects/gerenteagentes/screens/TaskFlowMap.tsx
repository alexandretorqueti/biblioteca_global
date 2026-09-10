import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AccountTreeRounded,
  BuildRounded,
  CancelRounded,
  CheckCircleRounded,
  ClearRounded,
  ContentPasteRounded,
  EditNoteRounded,
  ErrorOutlineRounded,
  FilterAltRounded,
  HourglassBottomRounded,
  InfoOutlined,
  PauseCircleRounded,
  RocketLaunchRounded,
  SearchRounded,
  SettingsRounded,
  PauseRounded,
  PlayArrowRounded,
  ReplayRounded,
  UnfoldLessRounded,
  UnfoldMoreRounded,
  WarningAmberRounded,
  RemoveRounded,
  AddRounded,
} from "@mui/icons-material"
import { Avatar, Box, Button, Chip, Collapse, FormControl, IconButton, InputLabel, LinearProgress, MenuItem, Paper, Select, Skeleton, Stack, TextField, Tooltip, Typography, useMediaQuery } from "@mui/material"
import { useTheme } from "@mui/material/styles"
import { TASK_STATUS_EXECUTING, TASK_STATUS_STARTABLE, taskStatusLabel } from "../motor-v2/src/shared/task-statuses"
import { calcularMetricas, deriveTaskPriority, formatTempoRelativo, projetoAvatar, type Prioridade } from "./taskFlowHelpers"

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
  subtaskCount?: number
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
  aoVivo?: boolean
  carregando?: boolean
  onStartTask?: (id: number) => void
  onPauseTask?: (id: number) => void
  onResumeTask?: (id: number) => void
}

interface FlowStation {
  id: string
  label: string
  subtitle: string
  statuses: string[]
  tone: "neutral" | "active" | "success" | "warning" | "danger"
}

export const MAIN_FLOW: FlowStation[] = [
  { id: "draft", label: "Rascunhos", subtitle: "não iniciadas ou pausadas sem subtarefas", statuses: ["draft"], tone: "neutral" },
  { id: "planned", label: "Planejadas", subtitle: "aguardando análise", statuses: ["planned"], tone: "neutral" },
  { id: "analyzing", label: "Em análise", subtitle: "IA analisando", statuses: ["analyzing"], tone: "active" },
  { id: "ready", label: "Fila de Execução", subtitle: "próxima subtarefa", statuses: ["ready"], tone: "neutral" },
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

// Ícones representativos por estação (1.2)
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

// Cores de borda lateral por prioridade (1.3 — barra lateral 4px)
const PRIORIDADE_BORDER_COLOR: Record<Prioridade, string> = {
  alta: "#d32f2f",   // error.main
  media: "#ed6c02",  // warning.main
  baixa: "#2e7d32",  // success.main
}

// Rótulo legível para prioridade em pt-BR (para tooltip rico)
const PRIORIDADE_LABEL: Record<Prioridade, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
}

// Status que podem exibir barra de progresso (1.3 — "se aplicável")
const PROGRESSO_STATUSES = new Set(["analyzing", "running", "motor_fix"])

// Mapeia id de estação para tone (para cores das barras do dashboard)
function estacaoToTone(estacaoId: string): FlowStation["tone"] {
  const allStations = [...MAIN_FLOW, ...SIDE_FLOW]
  const station = allStations.find((s) => s.id === estacaoId)
  return station?.tone ?? "neutral"
}

// Mapeia tone para cor CSS (para as barras do dashboard)
function toneToColor(tone: FlowStation["tone"]): string {
  switch (tone) {
    case "active": return "#1976d2" // primary.main
    case "success": return "#2e7d32" // success.dark
    case "warning": return "#ed6c02" // warning.main
    case "danger": return "#d32f2f" // error.main
    default: return "#9e9e9e" // grey
  }
}

// ─── Conectores SVG animados (2.1) ───────────────────────────────────────────

/**
 * FlowConnector: SVG com linha + gradiente em movimento (stroke-dashoffset animado)
 * e ponta chevron ('arrow with tail') substituindo ArrowForwardRounded/ArrowDownwardRounded.
 * 
 * Props:
 * - direction: 'horizontal' | 'vertical'
 * - hasMovement: intensifica animação quando há tarefas se movendo (efeito 'rio' 2.1b)
 */
function FlowConnector({ direction = "horizontal", hasMovement = false }: { direction?: "horizontal" | "vertical"; hasMovement?: boolean }) {
  const isHorizontal = direction === "horizontal"
  const width = isHorizontal ? 48 : 24
  const height = isHorizontal ? 24 : 48

  // Gradiente IDs únicos para evitar colisão
  const gradientId = `flow-grad-${direction}-${hasMovement ? "active" : "idle"}`

  // Duração da animação: mais rápida quando há movimento (efeito 'rio')
  const animDuration = hasMovement ? "0.8s" : "1.6s"
  const strokeOpacity = hasMovement ? 0.9 : 0.5

  return (
    <Box
      component="svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-testid={`flow-connector-${direction}`}
      sx={{ flexShrink: 0, overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2={isHorizontal ? "100%" : "0%"} y2={isHorizontal ? "0%" : "100%"}>
          <stop offset="0%" stopColor="#1976d2" stopOpacity="0.2" />
          <stop offset="50%" stopColor="#1976d2" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#1976d2" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      {/* Linha com gradiente em movimento */}
      <line
        x1={isHorizontal ? 0 : width / 2}
        y1={isHorizontal ? height / 2 : 0}
        x2={isHorizontal ? width - 10 : width / 2}
        y2={isHorizontal ? height / 2 : height - 10}
        stroke={`url(#${gradientId})`}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="6 4"
        style={{
          animation: `flow-dash ${animDuration} linear infinite`,
          opacity: strokeOpacity,
        }}
      />
      {/* Chevron na ponta (estilo 'arrow with tail') */}
      {isHorizontal ? (
        <path
          d={`M ${width - 12} ${height / 2 - 5} L ${width - 4} ${height / 2} L ${width - 12} ${height / 2 + 5}`}
          stroke="#1976d2"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          style={{ opacity: strokeOpacity }}
        />
      ) : (
        <path
          d={`M ${width / 2 - 5} ${height - 12} L ${width / 2} ${height - 4} L ${width / 2 + 5} ${height - 12}`}
          stroke="#1976d2"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          style={{ opacity: strokeOpacity }}
        />
      )}
    </Box>
  )
}

// ─── Keyframes globais (injetados via <style> no primeiro render) ────────────

const KEYFRAMES_CSS = `
@keyframes flow-dash {
  to { stroke-dashoffset: -20; }
}
@keyframes task-slide-in {
  0% { opacity: 0; transform: translateX(-12px); }
  100% { opacity: 1; transform: translateX(0); }
}
@keyframes task-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.02); }
}
@keyframes task-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(237, 108, 2, 0); }
  50% { box-shadow: 0 0 8px 2px rgba(237, 108, 2, 0.35); }
}
@keyframes task-fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes flow-dash { to { stroke-dashoffset: 0; } }
  @keyframes task-slide-in { 0%, 100% { opacity: 1; transform: none; } }
  @keyframes task-pulse { 0%, 100% { transform: none; } }
  @keyframes task-glow { 0%, 100% { box-shadow: none; } }
  @keyframes task-fade-in { 0%, 100% { opacity: 1; } }
}
`

let keyframesInjected = false
function ensureKeyframes() {
  if (keyframesInjected || typeof document === "undefined") return
  const style = document.createElement("style")
  style.setAttribute("data-testid", "flow-keyframes")
  style.textContent = KEYFRAMES_CSS
  document.head.appendChild(style)
  keyframesInjected = true
}

// Rótulo legível para o id da estação (para tooltips do dashboard)
function estacaoLabel(estacaoId: string): string {
  const allStations = [...MAIN_FLOW, ...SIDE_FLOW]
  const station = allStations.find((s) => s.id === estacaoId)
  return station?.label ?? estacaoId
}

function taskDescription(task: FlowTask): string {
  return typeof task.descricao === "string" && task.descricao.trim()
    ? task.descricao.trim()
    : "Tarefa sem descrição"
}

// Cores de borda superior por tone (1.2 — borda superior 3-4px)
const TONE_BORDER_COLOR: Record<FlowStation["tone"], string> = {
  neutral: "#9e9e9e",
  active: "#1976d2",
  success: "#2e7d32",
  warning: "#ed6c02",
  danger: "#d32f2f",
}

// Gradiente sutil de topo para base por tone (1.2)
function stationGradient(tone: FlowStation["tone"]): string {
  const hex = TONE_BORDER_COLOR[tone]
  return `linear-gradient(180deg, ${hex}10 0%, transparent 60%)`
}

/**
 * Determina o status efetivo de uma tarefa para fins de exibição no mapa.
 * Tarefas com status 'paused' e sem subtarefas (subtaskCount === 0 ou undefined)
 * são tratadas como 'draft' (Rascunhos) em vez de 'waiting' (Aguardando).
 */
export function getEffectiveStatus(task: FlowTask): string {
  if (task.status === "paused" && (task.subtaskCount === 0 || task.subtaskCount === undefined)) {
    return "draft"
  }
  return task.status
}

const PAGE_SIZE = 10

function Station({ station, tarefas, tarefasFiltradas, selectedTaskId, search, legendaAtiva, movingIds, compacto, onSelectTask, taskMatchesLegenda, onStartTask, onPauseTask, onResumeTask }: {
  station: FlowStation
  tarefas: FlowTask[]
  tarefasFiltradas: FlowTask[]
  selectedTaskId: number | ""
  search: string
  legendaAtiva: FlowStation["tone"] | null
  movingIds: Set<number>
  compacto: boolean
  onSelectTask: (id: number) => void
  taskMatchesLegenda: (task: FlowTask, station: FlowStation) => boolean
  onStartTask?: (id: number) => void
  onPauseTask?: (id: number) => void
  onResumeTask?: (id: number) => void
}) {
  const [expandida, setExpandida] = useState(false)
  const [compactoLocal, setCompactoLocal] = useState<boolean>(true)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const stationTasks = tarefas.filter((task) => station.statuses.includes(getEffectiveStatus(task)))
  // Tarefas da estação que passam nos filtros
  const stationTasksFiltradas = tarefasFiltradas.filter((task) => station.statuses.includes(getEffectiveStatus(task)))
  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR")
  const filteredVisible = stationTasksFiltradas
    .filter((task) => !normalizedSearch || `#${task.id} ${task.titulo}`.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
  // Se expandida, mostra todas; senão, usa paginação infinita (PAGE_SIZE por vez)
  const visibleTasks = expandida ? filteredVisible : filteredVisible.slice(0, visibleCount)
  const temMais = stationTasks.length > visibleTasks.length

  // Reset da paginação quando o termo de busca muda
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [normalizedSearch])

  // Handler de scroll para paginação infinita
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) {
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, stationTasks.length))
    }
  }, [stationTasks.length])

  const StationIcon = STATION_ICONS[station.id]
  const borderColor = TONE_BORDER_COLOR[station.tone]

  // Handler de teclado no header da estação (Enter/Space expande)
  const handleHeaderKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      setExpandida((prev) => !prev)
    }
  }, [])

  return (
    <Paper
      variant="outlined"
      data-testid={`flow-station-${station.id}`}
      tabIndex={0}
      role="group"
      aria-label={`${station.label}: ${stationTasks.length} tarefas`}
      sx={{
        p: 2.5,
        minWidth: 190,
        minHeight: compacto ? 80 : 196,
        borderWidth: 1.5,
        borderRadius: 3,
        borderTop: `4px solid ${borderColor}`,
        background: stationGradient(station.tone),
        bgcolor: "background.paper",
        transition: "box-shadow 120ms ease, transform 120ms ease, min-height 200ms ease",
        outline: "none",
        "&:focus-visible": {
          boxShadow: `0 0 0 3px ${borderColor}40`,
          borderColor: borderColor,
        },
      }}
    >
      {/* Header da estação — clicável para expandir/compactar (4.1) */}
      <Box
        onClick={() => !compacto && setExpandida((prev) => !prev)}
        onKeyDown={handleHeaderKeyDown}
        role={!compacto ? "button" : undefined}
        aria-expanded={!compacto ? expandida : undefined}
        data-testid={`flow-station-${station.id}-header`}
        sx={{ cursor: compacto ? "default" : "pointer", mb: compacto ? 0 : 0.5 }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            {StationIcon && <StationIcon sx={{ fontSize: 22, color: borderColor }} aria-hidden="true" />}
            <Box>
              <Typography fontWeight={750} sx={{ fontSize: "0.9rem" }}>{station.label}</Typography>
              {!compacto && <Typography variant="caption" sx={{ opacity: 0.78 }}>{station.subtitle}</Typography>}
            </Box>
          </Stack>
          {/* Contador em círculo/badge monoespaçado (1.2) + botão de compactação individual */}
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Box
              data-testid={`flow-count-${station.id}`}
              sx={{
                minWidth: 36,
                height: 36,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: `${borderColor}18`,
                border: `2px solid ${borderColor}`,
                fontFamily: "'Roboto Mono', ui-monospace, monospace",
                fontWeight: 800,
                fontSize: "1rem",
                color: borderColor,
                flexShrink: 0,
              }}
            >
              {stationTasks.length}
            </Box>
            <Tooltip title={compactoLocal ? "Compactar estação" : "Expandir estação"}>
              <IconButton
                size="small"
                data-testid={`flow-station-${station.id}-compact`}
                onClick={(e) => {
                  e.stopPropagation()
                  setCompactoLocal((prev) => !prev)
                }}
                sx={{
                  padding: 0.25,
                  color: borderColor,
                  "&:hover": { bgcolor: `${borderColor}14` },
                }}
              >
                {compactoLocal ? <RemoveRounded sx={{ fontSize: 16 }} /> : <AddRounded sx={{ fontSize: 16 }} />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Box>
      {/* Modo compacto: não mostra cards */}
      {!compacto && compactoLocal && (
        <>
          {station.statuses.length > 1 && (
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
              {station.statuses.map((status) => (
                <Chip key={status} size="small" label={`${taskStatusLabel(status)}: ${stationTasks.filter((task) => getEffectiveStatus(task) === status).length}`} sx={{ height: 20, fontSize: 10 }} />
              ))}
            </Stack>
          )}
          <Box
            data-testid={`flow-scroll-${station.id}`}
            onScroll={handleScroll}
            sx={{
              mt: 1.25,
              maxHeight: 360,
              overflowY: "auto",
              overscrollBehavior: "contain",
              pr: 0.5,
            }}
          >
          <Stack spacing={0.75}>
        {visibleTasks.map((task) => {
          const aiActive = ACTIVE_AI_STATUSES.has(task.status)
          const matchesLegenda = taskMatchesLegenda(task, station)
          const isSelected = task.id === selectedTaskId
          const prioridade = deriveTaskPriority(task.status)
          const prioridadeCor = PRIORIDADE_BORDER_COLOR[prioridade]
          const avatar = projetoAvatar(task.projetoId, task.projetoNome)
          const tempoRelativo = formatTempoRelativo(task.updatedAt ?? task.createdAt)
          const showProgresso = task.progresso != null && PROGRESSO_STATUSES.has(task.status) && task.progresso.total > 0
          const progressoPct = showProgresso ? Math.round((task.progresso!.verified / task.progresso!.total) * 100) : 0
          const projetoLabel = task.projetoNome && task.projetoNome.trim() ? task.projetoNome.trim() : `Projeto #${task.projetoId}`
          const ultimaAtualizacao = (task.updatedAt ?? task.createdAt)
            ? new Date((task.updatedAt ?? task.createdAt)!).toLocaleString("pt-BR")
            : "—"

          // Tooltip rico (1.3e): descrição + projeto + prioridade + atualização
          // Nota: campo responsável omitido — backend ainda não expõe essa informação.
          const tooltipContent = (
            <Box sx={{ maxWidth: 260 }}>
              <Typography variant="caption" fontWeight={700} display="block" sx={{ mb: 0.25, color: "common.white" }}>
                {taskDescription(task)}
              </Typography>
              <Typography variant="caption" display="block" sx={{ opacity: 0.85, color: "common.white" }}>
                Projeto: {projetoLabel}
              </Typography>
              <Typography variant="caption" display="block" sx={{ opacity: 0.85, color: "common.white" }}>
                Prioridade: {PRIORIDADE_LABEL[prioridade]}
              </Typography>
              <Typography variant="caption" display="block" sx={{ opacity: 0.7, color: "common.white" }}>
                Atualizado: {ultimaAtualizacao}
              </Typography>
            </Box>
          )

          // Animações (2.2): slide-in na chegada, pulsação em ativas, glow em IA
          const isMoving = movingIds.has(task.id)
          const isAiActive = ACTIVE_AI_STATUSES.has(task.status)
          const animationParts: string[] = []
          if (isMoving) animationParts.push("task-slide-in 0.5s ease-out 1")
          if (isAiActive && !isMoving) animationParts.push("task-pulse 2.5s ease-in-out infinite")
          if (isAiActive) animationParts.push("task-glow 2.5s ease-in-out infinite")
          if (!isMoving && !isAiActive) animationParts.push("task-fade-in 0.3s ease-out 1")

          return (
            <Tooltip key={task.id} title={tooltipContent} arrow placement="top">
              <Paper
                component="button"
                type="button"
                onClick={() => onSelectTask(task.id)}
                data-testid={`flow-task-${task.id}`}
                aria-label={`Abrir tarefa ${task.id}: ${task.titulo}`}
                elevation={isSelected ? 5 : 0}
                sx={{
                  width: "100%",
                  p: 0.8,
                  border: 0,
                  borderLeft: `4px solid ${prioridadeCor}`,
                  textAlign: "left",
                  cursor: "pointer",
                  bgcolor: isSelected ? "action.selected" : "background.paper",
                  color: "text.primary",
                  animation: animationParts.length > 0 ? animationParts.join(", ") : undefined,
                  opacity: matchesLegenda ? 1 : 0.25,
                  transition: "opacity 200ms ease, background-color 150ms ease, box-shadow 150ms ease",
                  "&:hover": { transform: "translateY(-1px)", boxShadow: 2 },
                  // prefers-reduced-motion: desativa animações via media query
                  "@media (prefers-reduced-motion: reduce)": {
                    animation: "none",
                  },
                }}
              >
                {/* Linha 1: Avatar + '#id título' noWrap + tempo */}
                <Stack direction="row" spacing={0.7} alignItems="center" sx={{ minWidth: 0 }}>
                  {/* Avatar do projeto (1.3a) — letra + cor determinística */}
                  <Avatar
                    sx={{
                      width: 22,
                      height: 22,
                      fontSize: 11,
                      fontWeight: 700,
                      bgcolor: avatar.cor,
                      color: "common.white",
                      flexShrink: 0,
                    }}
                    aria-label={`Projeto ${projetoLabel}`}
                    data-testid={`flow-task-avatar-${task.id}`}
                  >
                    {avatar.letra}
                  </Avatar>
                  {aiActive && <SettingsRounded aria-label="IA trabalhando" sx={{ flexShrink: 0, fontSize: 18, color: "warning.main", animation: "gear-spin 2s linear infinite", "@keyframes gear-spin": { to: { transform: "rotate(360deg)" } } }} />}
                  {station.tone === "danger" && <ErrorOutlineRounded sx={{ flexShrink: 0, fontSize: 17, color: "error.main" }} />}
                  <Typography variant="caption" fontWeight={700} noWrap sx={{ minWidth: 0, flex: 1 }}>#{task.id} {task.titulo}</Typography>
                  {/* Tempo na estação (1.3c) */}
                  <Typography
                    variant="caption"
                    noWrap
                    data-testid={`flow-task-tempo-${task.id}`}
                    sx={{ flexShrink: 0, fontSize: "0.65rem", opacity: 0.65, fontFamily: "'Roboto Mono', ui-monospace, monospace" }}
                  >
                    {tempoRelativo}
                  </Typography>
                  {/* Ícone de info — trigger visual do tooltip rico (mantém flow-task-description-<id>) */}
                  <Box
                    component="span"
                    aria-label={`Detalhes da tarefa ${task.id}`}
                    data-testid={`flow-task-description-${task.id}`}
                    sx={{ display: "inline-flex", flexShrink: 0, color: "action.active", cursor: "help" }}
                  >
                    <InfoOutlined sx={{ fontSize: 15 }} />
                  </Box>
                </Stack>
                {/* Linha 2: Mini barra de progresso (1.3d) — só se aplicável */}
                {showProgresso && (
                  <LinearProgress
                    variant="determinate"
                    value={progressoPct}
                    data-testid={`flow-task-progresso-${task.id}`}
                    aria-label={`Progresso da tarefa ${task.id}: ${progressoPct}%`}
                    sx={{
                      mt: 0.5,
                      height: 4,
                      borderRadius: 2,
                      bgcolor: "action.hover",
                      "& .MuiLinearProgress-bar": {
                        borderRadius: 2,
                        bgcolor: prioridadeCor,
                      },
                    }}
                  />
                )}
                {/* Botões de ação (play/pause/restart) — icon-only com tooltip */}
                {(TASK_STATUS_STARTABLE.has(task.status) || TASK_STATUS_EXECUTING.has(task.status) || task.status === "paused") && (
                  <Stack direction="row" justifyContent="flex-end" sx={{ mt: 0.25 }}>
                    {TASK_STATUS_STARTABLE.has(task.status) && onStartTask && (
                      <Tooltip title="Iniciar tarefa" arrow>
                        <IconButton
                          size="small"
                          data-testid={`task-action-start-${task.id}`}
                          onClick={(e) => { e.stopPropagation(); onStartTask(task.id) }}
                          sx={{ p: 0.25 }}
                        >
                          <PlayArrowRounded sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {TASK_STATUS_EXECUTING.has(task.status) && onPauseTask && (
                      <Tooltip title="Pausar tarefa" arrow>
                        <IconButton
                          size="small"
                          data-testid={`task-action-pause-${task.id}`}
                          onClick={(e) => { e.stopPropagation(); onPauseTask(task.id) }}
                          sx={{ p: 0.25 }}
                        >
                          <PauseRounded sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {task.status === "paused" && onResumeTask && (
                      <Tooltip title="Retomar tarefa" arrow>
                        <IconButton
                          size="small"
                          data-testid={`task-action-resume-${task.id}`}
                          onClick={(e) => { e.stopPropagation(); onResumeTask(task.id) }}
                          sx={{ p: 0.25 }}
                        >
                          <ReplayRounded sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                )}
              </Paper>
            </Tooltip>
          )
        })}
          {normalizedSearch && stationTasks.length > 0 && visibleTasks.length === 0 && <Typography variant="caption" sx={{ opacity: 0.65 }}>Nenhuma correspondência</Typography>}
          {!normalizedSearch && !expandida && temMais && <Typography variant="caption" textAlign="center" sx={{ opacity: 0.72 }}>+ {stationTasks.length - visibleTasks.length} tarefas</Typography>}
          {expandida && filteredVisible.length > 3 && <Typography variant="caption" textAlign="center" sx={{ opacity: 0.72, mt: 0.5 }}>Mostrando todas ({filteredVisible.length})</Typography>}
          </Stack>
          </Box>
        </>
      )}
      {/* Indicador de expansão */}
      {!compacto && temMais && (
        <Stack direction="row" justifyContent="center" sx={{ mt: 0.5 }}>
          {expandida
            ? <UnfoldLessRounded sx={{ fontSize: 18, color: "action.active" }} aria-label="Recolher estação" />
            : <UnfoldMoreRounded sx={{ fontSize: 18, color: "action.active" }} aria-label="Expandir estação" />}
        </Stack>
      )}
    </Paper>
  )
}

export default function TaskFlowMap({ tarefas, selectedTaskId, search = "", motorActivities = [], onSelectTask, projetos = [], filtros: filtrosExternos, onFiltrosChange, aoVivo = true, carregando = false, onStartTask, onPauseTask, onResumeTask }: TaskFlowMapProps) {
  // Injeta keyframes globais na primeira renderização
  ensureKeyframes()

  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"))

  const previousStatuses = useRef(new Map<number, string>())
  const [movements, setMovements] = useState<Array<{ id: number; from: string; to: string }>>([])
  const [legendaAtiva, setLegendaAtiva] = useState<FlowStation["tone"] | null>(null)
  const [compacto, setCompacto] = useState(false)
  const [filtroMobileAberto, setFiltroMobileAberto] = useState(false)

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

  // Métricas consolidadas para o cabeçalho e dashboard
  const metricas = useMemo(() => calcularMetricas(tarefas), [tarefas])

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
      {/* ═══ Cabeçalho impactante (1.1) ═══ */}
      <Box sx={{ mb: 2 }} data-testid="map-header">
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <AccountTreeRounded sx={{ fontSize: 32, color: "primary.main" }} aria-hidden="true" />
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h6" fontWeight={800} sx={{ fontSize: { xs: "1.15rem", sm: "1.25rem" } }}>
                  Mapa Vivo da Operação
                </Typography>
                {aoVivo && (
                  <Chip
                    label="AO VIVO"
                    size="small"
                    color="error"
                    data-testid="map-badge-ao-vivo"
                    sx={{
                      fontWeight: 700,
                      fontSize: "0.65rem",
                      height: 22,
                      animation: "map-badge-ao-vivo-pulse 2s ease-in-out infinite",
                      "@keyframes map-badge-ao-vivo-pulse": {
                        "0%, 100%": { opacity: 1, transform: "scale(1)" },
                        "50%": { opacity: 0.7, transform: "scale(1.05)" },
                      },
                    }}
                  />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Acompanhe as tarefas percorrendo o fluxo em tempo real.
              </Typography>
            </Box>
          </Stack>
          {/* Métricas rápidas no topo (1.1) */}
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap data-testid="map-metricas-rapidas">
            <Typography variant="body2" data-testid="map-metric-total">
              <Box component="span" sx={{ fontWeight: 800, fontFamily: "'Roboto Mono', monospace", fontSize: "1.1rem" }}>{metricas.total}</Box> total
            </Typography>
            <Typography variant="body2" data-testid="map-metric-andamento">
              <Box component="span" sx={{ fontWeight: 800, fontFamily: "'Roboto Mono', monospace", fontSize: "1.1rem", color: "primary.main" }}>{metricas.emAndamento}</Box> em andamento
            </Typography>
            <Typography variant="body2" data-testid="map-metric-hoje">
              <Box component="span" sx={{ fontWeight: 800, fontFamily: "'Roboto Mono', monospace", fontSize: "1.1rem", color: "success.main" }}>{metricas.concluidasHoje}</Box> concluídas hoje
            </Typography>
          </Stack>
        </Stack>
        {/* Separador visual com gradiente */}
        <Box
          sx={{
            mt: 1.5,
            height: 2,
            background: "linear-gradient(90deg, var(--mui-palette-primary-main) 0%, transparent 100%)",
            borderRadius: 1,
          }}
          data-testid="map-header-separator"
          aria-hidden="true"
        />
      </Box>

      {/* ═══ Dashboard compacto (3.1) ═══ */}
      <Paper
        variant="outlined"
        sx={{ p: 1.5, mb: 2, bgcolor: "action.hover", borderRadius: 2 }}
        data-testid="map-dashboard"
      >
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          {/* Total de tarefas ativas */}
          <Stack alignItems="center" spacing={0.5} data-testid="map-dashboard-total-ativas">
            <Typography variant="caption" color="text.secondary">Ativas</Typography>
            <Typography variant="h6" fontWeight={800} sx={{ fontFamily: "'Roboto Mono', monospace" }}>
              {metricas.total}
            </Typography>
          </Stack>

          {/* Mini gráfico de barras por fase */}
          <Stack direction="row" spacing={0.5} alignItems="flex-end" sx={{ height: 48 }} data-testid="map-dashboard-barras">
            {Object.entries(metricas.porEstacao).map(([estacao, count]) => {
              const maxCount = Math.max(1, ...Object.values(metricas.porEstacao))
              const altura = count > 0 ? Math.max(6, (count / maxCount) * 40) : 4
              const tone = estacaoToTone(estacao)
              const cor = toneToColor(tone)
              return (
                <Tooltip key={estacao} title={`${estacaoLabel(estacao)}: ${count}`} arrow placement="top">
                  <Box
                    sx={{
                      width: 18,
                      height: altura,
                      bgcolor: cor,
                      borderRadius: "3px 3px 0 0",
                      transition: "height 300ms ease",
                      opacity: count > 0 ? 1 : 0.3,
                    }}
                    data-testid={`map-dashboard-bar-${estacao}`}
                    aria-label={`${estacaoLabel(estacao)}: ${count}`}
                  />
                </Tooltip>
              )
            })}
          </Stack>

          {/* Tempo médio de execução */}
          <Stack alignItems="center" spacing={0.5} data-testid="map-dashboard-tempo-medio">
            <Typography variant="caption" color="text.secondary">Tempo médio</Typography>
            <Typography variant="body2" fontWeight={700} sx={{ fontFamily: "'Roboto Mono', monospace" }}>
              {metricas.tempoMedioExecucao}
            </Typography>
          </Stack>

          {/* Tarefas bloqueadas (destaque vermelho) */}
          <Stack alignItems="center" spacing={0.5} data-testid="map-metric-bloqueadas">
            <Typography variant="caption" color="text.secondary">Bloqueadas</Typography>
            <Typography
              variant="h6"
              fontWeight={metricas.bloqueadas > 0 ? 800 : 700}
              sx={{
                fontFamily: "'Roboto Mono', monospace",
                color: metricas.bloqueadas > 0 ? "error.main" : "text.secondary",
              }}
            >
              {metricas.bloqueadas}
            </Typography>
          </Stack>

          {/* IA trabalhando (preservado do flow-ai-activity) */}
          <Stack direction="row" spacing={0.5} alignItems="center" data-testid="flow-ai-activity">
            <SettingsRounded sx={{ color: activeAiCount ? "warning.main" : "text.disabled", animation: activeAiCount ? "legend-spin 2s linear infinite" : "none", "@keyframes legend-spin": { to: { transform: "rotate(360deg)" } }, fontSize: 18 }} />
            <Typography variant="caption" color="text.secondary">
              {activeAiCount ? `IA trabalhando (${activeAiCount})` : "Nenhuma IA trabalhando"}
            </Typography>
          </Stack>

          {/* Atividade do Motor (preservado do flow-motor-activity) */}
          <Stack direction="row" spacing={0.5} alignItems="center" data-testid="flow-motor-activity">
            <SettingsRounded sx={{ color: motorActivities.length ? "info.main" : "text.disabled", animation: motorActivities.length ? "motor-gear-spin 2s linear infinite" : "none", "@keyframes motor-gear-spin": { to: { transform: "rotate(360deg)" } }, fontSize: 18 }} />
            <Typography variant="caption" color="text.secondary">
              {motorActivities.length
                ? motorActivities.map((activity) => `${activity.phase === "verify" ? "verificando" : "deployando"} ${activity.taskId}`).join(" · ")
                : "Motor sem verificações ou deploys"}
            </Typography>
          </Stack>
        </Stack>
      </Paper>

      {/* Barra de filtro integrada ao topo (6.1 — colapsável em mobile) */}
      <Paper
        variant="outlined"
        sx={{ p: 1.5, mb: 2, bgcolor: "action.hover", borderRadius: 2 }}
        data-testid="map-filter-bar"
      >
        {/* Linha superior: toggle mobile + contador */}
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: isMobile && !filtroMobileAberto ? 0 : 1 }}>
          {/* Botão funil (visível só em mobile) */}
          <IconButton
            onClick={() => setFiltroMobileAberto((prev) => !prev)}
            data-testid="map-filter-toggle"
            aria-label={filtroMobileAberto ? "Recolher filtros" : "Expandir filtros"}
            aria-expanded={filtroMobileAberto}
            color={filtroMobileAberto ? "primary" : "default"}
            sx={{ display: { xs: "flex", sm: "none" } }}
          >
            <FilterAltRounded />
          </IconButton>
          {/* Contador (sempre visível) */}
          <Typography variant="caption" color="text.secondary" data-testid="map-filter-contador" sx={{ ml: "auto" }}>
            {contadorFiltro}
          </Typography>
          {/* Botão limpar (sempre visível quando há filtros) */}
          {hasFiltrosAtivos && (
            <Button
              size="small"
              startIcon={<ClearRounded />}
              onClick={limparFiltros}
              data-testid="map-filter-limpar"
              sx={{ minWidth: "auto", ml: 1 }}
            >
              Limpar
            </Button>
          )}
        </Stack>

        {/* Campos do filtro (colapsável em mobile, sempre visível em desktop) */}
        <Collapse in={!isMobile || filtroMobileAberto} timeout="auto" unmountOnExit={isMobile}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
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
          </Stack>
        </Collapse>
      </Paper>

      {movements.map((movement) => <Chip key={movement.id} color="info" sx={{ mb: 1.5, mr: 1 }} label={`#${movement.id} · ${taskStatusLabel(movement.from)} → ${taskStatusLabel(movement.to)}`} data-testid={`flow-movement-${movement.id}`} />)}

      {/* Toggle Compactar (4.1) */}
      {/* Nota: mini-mapa NÃO implementado (opcional conforme especificação) — 
          o toggle compactar + expansão por estação atendem o mesmo propósito 
          de visão geral sem a complexidade adicional de um mini-mapa. */}
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
        <Button
          size="small"
          startIcon={compacto ? <UnfoldMoreRounded /> : <UnfoldLessRounded />}
          onClick={() => setCompacto((prev) => !prev)}
          data-testid="map-toggle-compactar"
          variant={compacto ? "contained" : "outlined"}
          sx={{ minWidth: "auto" }}
        >
          {compacto ? "Expandir" : "Compactar"}
        </Button>
      </Stack>

      {/* 7.1 — Skeleton loaders enquanto carrega */}
      {carregando ? (
        <Box data-testid="map-skeleton-container">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "stretch", sm: "center" }}
            justifyContent="center"
            flexWrap="wrap"
            useFlexGap
            spacing={2}
            sx={{ width: "100%" }}
          >
            {MAIN_FLOW.map((station, index) => (
              <React.Fragment key={station.id}>
                <Skeleton
                  variant="rounded"
                  width={190}
                  height={compacto ? 80 : 196}
                  animation="wave"
                  data-testid={`map-skeleton-${station.id}`}
                  sx={{
                    borderRadius: 3,
                    animationDelay: `${index * 60}ms`,
                    animationDuration: "1.2s",
                  }}
                />
                {index < MAIN_FLOW.length - 1 && (
                  <Skeleton
                    variant="rounded"
                    width={48}
                    height={24}
                    animation="wave"
                    sx={{ display: { xs: "none", sm: "block" }, animationDelay: `${(index + 0.5) * 60}ms` }}
                  />
                )}
              </React.Fragment>
            ))}
          </Stack>
          <Stack alignItems="center" sx={{ width: "100%", my: 0.5 }}>
            <Skeleton variant="rounded" width={24} height={48} animation="wave" sx={{ display: { xs: "none", sm: "block" } }} />
          </Stack>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="center"
            alignItems={{ xs: "stretch", sm: "center" }}
            flexWrap="wrap"
            useFlexGap
            spacing={2}
            sx={{ width: "100%" }}
          >
            {SIDE_FLOW.map((station, index) => (
              <React.Fragment key={station.id}>
                <Skeleton
                  variant="rounded"
                  width={190}
                  height={compacto ? 80 : 196}
                  animation="wave"
                  data-testid={`map-skeleton-${station.id}`}
                  sx={{
                    borderRadius: 3,
                    animationDelay: `${(MAIN_FLOW.length + index) * 60}ms`,
                    animationDuration: "1.2s",
                  }}
                />
                {index < SIDE_FLOW.length - 1 && (
                  <Skeleton
                    variant="rounded"
                    width={48}
                    height={24}
                    animation="wave"
                    sx={{ display: { xs: "none", sm: "block" }, animationDelay: `${(MAIN_FLOW.length + index + 0.5) * 60}ms` }}
                  />
                )}
              </React.Fragment>
            ))}
          </Stack>
        </Box>
      ) : (
      <Box sx={{ overflowX: "auto", pb: 1 }}>
        {/* 6.1 — Direção responsiva: column em xs (empilhado), row em sm+ (horizontal) */}
        {/* Em mobile, overflowX + scrollSnapType como equivalente de swipe */}
        <Stack
          direction={{ xs: "column", sm: "row" }}
          alignItems={{ xs: "stretch", sm: "center" }}
          justifyContent="center"
          flexWrap={{ xs: "nowrap", sm: "wrap" }}
          useFlexGap
          spacing={2}
          sx={{
            width: "100%",
            // 6.1 — Swipe em mobile: scroll-snap como equivalente de gestos
            ...(isMobile && {
              overflowX: "auto" as const,
              scrollSnapType: "x mandatory" as const,
              WebkitOverflowScrolling: "touch" as const,
              "& > *": {
                scrollSnapAlign: "start" as const,
                flexShrink: 0,
              },
            }),
          }}
        >
          {MAIN_FLOW.map((station, index) => (
            <React.Fragment key={station.id}>
              <Box
                sx={{
                  // 7.1 — Progressive loading: fade-in escalonado ao carregar
                  animation: `task-fade-in 0.3s ease-out ${index * 60}ms both`,
                  "@media (prefers-reduced-motion: reduce)": {
                    animation: "none",
                  },
                }}
              >
                <Station
                  station={station}
                  tarefas={tarefas}
                  tarefasFiltradas={tarefasFiltradas}
                  selectedTaskId={selectedTaskId}
                  search={search}
                  legendaAtiva={legendaAtiva}
                  movingIds={movingIds}
                  compacto={compacto}
                  onSelectTask={onSelectTask}
                  taskMatchesLegenda={taskMatchesLegenda}
                  onStartTask={onStartTask}
                  onPauseTask={onPauseTask}
                  onResumeTask={onResumeTask}
                />
              </Box>
              {index < MAIN_FLOW.length - 1 && <FlowConnector direction="horizontal" hasMovement={movingIds.size > 0} />}
            </React.Fragment>
          ))}
        </Stack>
        {/* Conector vertical entre MAIN_FLOW e SIDE_FLOW (2.1 — direção do fluxo clara) */}
        <Stack alignItems="center" sx={{ width: "100%", my: 0.5 }}>
          <FlowConnector direction="vertical" hasMovement={movingIds.size > 0} />
        </Stack>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="center"
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap={{ xs: "nowrap", sm: "wrap" }}
          useFlexGap
          spacing={2}
          sx={{
            width: "100%",
            ...(isMobile && {
              overflowX: "auto" as const,
              scrollSnapType: "x mandatory" as const,
              WebkitOverflowScrolling: "touch" as const,
              "& > *": {
                scrollSnapAlign: "start" as const,
                flexShrink: 0,
              },
            }),
          }}
        >
          {SIDE_FLOW.map((station, index) => (
            <React.Fragment key={station.id}>
              <Box
                sx={{
                  animation: `task-fade-in 0.3s ease-out ${(MAIN_FLOW.length + index) * 60}ms both`,
                  "@media (prefers-reduced-motion: reduce)": {
                    animation: "none",
                  },
                }}
              >
                <Station
                  station={station}
                  tarefas={tarefas}
                  tarefasFiltradas={tarefasFiltradas}
                  selectedTaskId={selectedTaskId}
                  search={search}
                  legendaAtiva={legendaAtiva}
                  movingIds={movingIds}
                  compacto={compacto}
                  onSelectTask={onSelectTask}
                  taskMatchesLegenda={taskMatchesLegenda}
                  onStartTask={onStartTask}
                  onPauseTask={onPauseTask}
                  onResumeTask={onResumeTask}
                />
              </Box>
              {index < SIDE_FLOW.length - 1 && <FlowConnector direction="horizontal" hasMovement={movingIds.size > 0} />}
            </React.Fragment>
          ))}
        </Stack>
      </Box>
      )}

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
