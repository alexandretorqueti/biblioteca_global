/**
 * Faixa de status dos agentes — representação visual animada dos três agentes
 * (Analista, Desenvolvedor e Monitor) no Mapa de agentes.
 *
 * Contrato (GET /gerenteagentes/motor-activity → motor-v3 /api/motor/stats):
 *   motor: { isActive, isRunning, activity: { kind, message, taskIds[] } | null }
 *   workers: Array<{ role, active, model, taskId, subtaskId, phase }>
 *
 * Cada agente (Analista, Desenvolvedor, Monitor) exibe o código da tarefa em
 * tratamento (#taskId) e da subtarefa (·SsubtaskId) quando ativo. A seção do
 * Motor exibe os códigos de todas as tarefas da leva de deploy (taskIds).
 */
import React, { useMemo } from "react"
import {
  AccountCircleRounded, CodeRounded, SupervisedUserCircleRounded,
  PlayArrowRounded, PauseRounded, ModelTrainingRounded
} from "@mui/icons-material"
import {
  Box, Chip, Paper, Stack, Typography, useMediaQuery, useTheme
} from "@mui/material"

/** Descrição de atividade do motor (kind + taskIds da leva). */
export interface MotorActivityInfo {
  kind: "testing" | "worktree" | "deploying" | "executing"
  message: string
  taskIds: string[]
}

export interface WorkerInfo {
  role: "analyst" | "developer" | "manager"
  active: boolean
  model?: string | null
  taskId?: string | null
  subtaskId?: number | null
  phase?: string | null
}

export interface AgentStatus {
  id: string
  name: string
  role: string
  icon: React.ComponentType<{ sx?: object }>
  model?: string | null
  status: "idle" | "working" | "deploying"
  taskId?: string | null
  subtaskId?: number | null
}

export interface AgentStatusStripProps {
  motorActive: boolean
  motorIsRunning?: boolean
  motorActivity?: MotorActivityInfo | null
  workers?: WorkerInfo[]
}

function activityLabel(kind: MotorActivityInfo["kind"]): string {
  if (kind === "deploying") return "Realizando deploy"
  if (kind === "worktree") return "Criando worktree"
  if (kind === "testing") return "Testando trabalho do desenvolvedor"
  return "Executando tarefa"
}

function getAgentStatus(agentId: string, workers: WorkerInfo[]): AgentStatus {
  const worker = workers.find(w => w.role === agentId)
  let status: AgentStatus["status"] = "idle"
  let taskId: string | null = null
  let subtaskId: number | null = null
  const model = worker?.model ?? null

  if (worker?.active) {
    status = worker.phase?.toLowerCase().includes('deploy') ? "deploying" : "working"
    taskId = worker.taskId ?? null
    subtaskId = worker.subtaskId ?? null
  }

  return {
    id: agentId,
    name: agentId === "analyst" ? "Analista" : agentId === "developer" ? "Desenvolvedor" : "Monitor",
    role: agentId === "analyst" ? "Analista" : agentId === "developer" ? "Desenvolvedor" : "Gerente",
    icon: agentId === "analyst" ? AccountCircleRounded : agentId === "developer" ? CodeRounded : SupervisedUserCircleRounded,
    status,
    taskId,
    subtaskId,
    model
  }
}

export default function AgentStatusStrip({ motorActive, motorIsRunning = false, motorActivity = null, workers = [] }: AgentStatusStripProps) {
  const theme = useTheme()
  const isXs = useMediaQuery(theme.breakpoints.down("sm"))
  const isSm = useMediaQuery(theme.breakpoints.down("md"))

  // Determinar estado do motor (ícone e texto)
  const motorState = useMemo(() => {
    if (!motorActive) {
      return { icon: PauseRounded, text: "Motor pausado", color: "text.secondary" }
    }
    if (motorActivity) {
      return {
        icon: ModelTrainingRounded,
        text: activityLabel(motorActivity.kind),
        color: "primary.main",
      }
    }
    if (motorIsRunning) {
      return { icon: PlayArrowRounded, text: "Operando", color: "success.main" }
    }
    return { icon: PlayArrowRounded, text: "Aguardando atividade", color: "text.secondary" }
  }, [motorActive, motorIsRunning, motorActivity])

  // Os três agentes: Analista e Desenvolvedor dos workers; Monitor do worker 'manager'
  const agents: AgentStatus[] = useMemo(() => {
    return [
      getAgentStatus("analyst", workers),
      getAgentStatus("developer", workers),
      getAgentStatus("manager", workers),
    ]
  }, [workers])

  // TaskIds da leva de deploy (exibidos como chips na seção do Motor)
  const deployTaskIds = motorActivity?.kind === "deploying" ? motorActivity.taskIds : []

  return (
    <Paper
      variant="outlined"
      data-testid="agent-status-strip"
      sx={{
        p: isXs ? 1 : 1.5,
        borderRadius: 2,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        boxShadow: "0 2px 4px rgba(0,0,0,0.04)"
      }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={isXs ? 1 : 2}
        sx={{ flexWrap: "wrap", useFlexGap: true }}
      >
        {/* Agentes */}
        {agents.map((agent) => (
          <AgentStatusItem key={agent.id} agent={agent} compact={isXs || isSm} />
        ))}

        {/* Estado do motor */}
        <Box
          data-testid="motor-state-box"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            px: 1.5,
            py: 0.5,
            borderRadius: 1,
            bgcolor: motorActive ? "action.hover" : "action.disabledBackground",
            border: "1px solid",
            borderColor: motorActive ? "divider" : "transparent"
          }}
        >
          <motorState.icon sx={{ fontSize: 18, color: motorState.color }} />
          <Typography variant="caption" fontWeight={700} sx={{ color: motorState.color, whiteSpace: "nowrap" }}>
            {motorState.text}
          </Typography>
          {deployTaskIds.map((id) => (
            <Chip
              key={`deploy-${id}`}
              size="small"
              label={`#${id}`}
              variant="outlined"
              sx={{ ml: 0.25 }}
              data-testid={`motor-deploy-task-${id}`}
            />
          ))}
        </Box>
      </Stack>
    </Paper>
  )
}

interface AgentStatusItemProps {
  agent: AgentStatus
  compact: boolean
}

function AgentStatusItem({ agent, compact }: AgentStatusItemProps) {
  const theme = useTheme()
  const isXs = useMediaQuery(theme.breakpoints.down("sm"))

  const isWorking = agent.status === "working" || agent.status === "deploying"
  const statusColor = isWorking ? "success.main" : "text.disabled"

  return (
    <Box
      data-testid={`agent-status-${agent.id}`}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 0.75 : 1,
        px: compact ? 1 : 1.25,
        py: 0.5,
        borderRadius: 1.5,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: isWorking ? "action.hover" : "background.default",
        transition: "all 0.2s ease"
      }}
      aria-label={`${agent.name} — ${agent.role}`}
    >
      {/* Ícone do agente com animação quando ativo */}
      <Box
        sx={{
          position: "relative",
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          bgcolor: isWorking ? "success.main" : "action.disabledBackground",
          color: isWorking ? "white" : "text.disabled"
        }}
      >
        <agent.icon sx={{ fontSize: isXs ? 16 : 20 }} />
        {isWorking && (
          <Box
            sx={{
              position: "absolute",
              inset: -4,
              borderRadius: "50%",
              border: `2px solid ${theme.palette.success.main}`,
              opacity: 0.4,
              animation: "ripple 2s cubic-bezier(0.25, 0.46, 0.45, 0.94) infinite"
            }}
          />
        )}
      </Box>

      {/* Texto do agente */}
      <Stack direction="column" spacing={0.25} sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          variant="caption"
          fontWeight={700}
          sx={{
            lineHeight: 1.2,
            color: "text.primary",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }}
        >
          {agent.name}
        </Typography>
        {isWorking && agent.taskId && (
          <Typography
            variant="caption"
            data-testid={`agent-task-code-${agent.id}`}
            sx={{
              fontSize: 10,
              lineHeight: 1.1,
              color: "primary.main",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontWeight: 600
            }}
          >
            #{agent.taskId}{agent.subtaskId != null ? ` · S${agent.subtaskId}` : ""}
          </Typography>
        )}
        {!isWorking && agent.model && (
          <Typography
            variant="caption"
            sx={{
              fontSize: 10,
              lineHeight: 1.1,
              color: "text.secondary",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis"
            }}
          >
            {agent.model}
          </Typography>
        )}
        {!agent.model && !isWorking && (
          <Typography variant="caption" sx={{ fontSize: 10, color: "text.disabled" }}>
            Inativo
          </Typography>
        )}
      </Stack>

      {/* Indicador de atividade */}
      <Box
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          bgcolor: statusColor,
          flexShrink: 0
        }}
        aria-hidden="true"
      />
    </Box>
  )
}

// Keyframes para animação de pulse/ripple
const KEYFRAMES_CSS = `
@keyframes ripple {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  100% {
    transform: scale(2.5);
    opacity: 0;
  }
}
`

let keyframesInjected = false
function ensureKeyframes() {
  if (keyframesInjected || typeof document === "undefined") return
  const style = document.createElement("style")
  style.setAttribute("data-testid", "agent-status-strip-keyframes")
  style.textContent = KEYFRAMES_CSS
  document.head.appendChild(style)
  keyframesInjected = true
}

if (typeof document !== "undefined") {
  ensureKeyframes()
}
