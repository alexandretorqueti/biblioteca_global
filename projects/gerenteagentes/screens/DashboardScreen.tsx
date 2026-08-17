/**
 * DashboardScreen — visao do gerente de agentes:
 * - projetos cadastrados com contagem total de tarefas
 * - tarefas em execucao por agente
 * - ultima atividade (lista resumida)
 *
 * Usa ExternalApiClient para a API externa do motor (http://api.tarefas.localhost)
 * e o RestEntityClient interno para dados locais do projeto gerenteagentes.
 * Estados loading/erro/404 sao tratados sem crash.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Chip, Paper, Stack, Typography, Alert, CircularProgress, Grid } from "@mui/material"
import {
  DashboardRounded,
  SmartToyRounded,
  TaskAltRounded,
  PlayCircleRounded,
  CheckCircleRounded,
  CancelRounded,
  PendingRounded,
  HistoryRounded,
} from "@mui/icons-material"
import type { ReactNode } from "react"
import { ExternalApiClient } from "@biblioteca-global/api-client"

/* ------------------------------------------------------------------ */
/*  Tipos locais                                                     */
/* ------------------------------------------------------------------ */

interface ProjetoExterno {
  id: number | string
  nome: string
  slug: string
  tarefasCount?: number
}

interface TarefaExterna {
  id: number | string
  titulo: string
  status: string
  prioridade: number
  agenteId: number | string
  iniciadaEm?: string
}

interface UltimaAtividade {
  id: number | string
  tipo: "tarefa_iniciada" | "tarefa_concluida" | "agente_alterado"
  titulo: string
  agenteId: number | string
  agenteNome: string
  em: string // ISO timestamp
}

/* ------------------------------------------------------------------ */
/*  Mapas de estado / icone                                           */
/* ------------------------------------------------------------------ */

const STATUS_TAREFA_LABEL: Record<string, string> = {
  pendente: "Pendente",
  em_andamento: "Em andamento",
  concluida: "Concluída",
  cancelada: "Cancelada",
}

const STATUS_CHIP: Record<string, "default" | "success" | "warning" | "error" | "info"> = {
  pendente: "default",
  em_andamento: "warning",
  concluida: "success",
  cancelada: "error",
}

const ICON_FOR_STATUS: Record<string, ReactNode> = {
  pendente: <PendingRounded sx={{ fontSize: 18 }} />,
  em_andamento: <PlayCircleRounded sx={{ fontSize: 18 }} />,
  concluida: <CheckCircleRounded sx={{ fontSize: 18 }} />,
  cancelada: <CancelRounded sx={{ fontSize: 18 }} />,
}

/* ------------------------------------------------------------------ */
/*  Componente: CardResumo                                           */
/* ------------------------------------------------------------------ */

function CardResumo({
  titulo,
  valor,
  icone,
  cor = "primary",
}: {
  titulo: string
  valor: number | string
  icone: ReactNode
  cor?: "primary" | "success" | "warning" | "error" | "info"
}): ReactNode {
  return (
    <Paper
      variant="outlined"
      data-testid="card-resumo"
      sx={{ p: 2, display: "flex", alignItems: "center", gap: 2 }}
    >
      <Box
        sx={{
          width: 48,
          height: 48,
          borderRadius: 2,
          bgcolor: `${cor}.lighter`,
          color: `${cor}.main`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icone}
      </Box>
      <Stack>
        <Typography variant="caption" color="text.secondary">
          {titulo}
        </Typography>
        <Typography variant="h4" fontWeight={800}>
          {valor}
        </Typography>
      </Stack>
    </Paper>
  )
}

/* ------------------------------------------------------------------ */
/*  Componente: CardAgente                                           */
/* ------------------------------------------------------------------ */

function CardAgente({
  agenteNome,
  tarefasEmAndamento,
  totalTarefas,
}: {
  agenteNome: string
  tarefasEmAndamento: number
  totalTarefas: number
}): ReactNode {
  return (
    <Paper variant="outlined" data-testid="card-agente">
      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <SmartToyRounded color="primary" />
          <Typography variant="subtitle1" fontWeight={700}>
            {agenteNome}
          </Typography>
        </Stack>

        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1 }}>
          <Chip size="small" label={`${totalTarefas} tarefas`} color="default" />
          {tarefasEmAndamento > 0 && (
            <Chip size="small" label={`${tarefasEmAndamento} em andamento`} color="warning" />
          )}
        </Box>

        {/* Barras de progresso por status */}
        {(() => {
          const pendentes = totalTarefas - tarefasEmAndamento
          if (pendentes <= 0) return null
          return (
            <Stack direction="row" spacing={0.5} height={6} sx={{ borderRadius: 1, overflow: "hidden", bgcolor: "grey.200" }}>
              {tarefasEmAndamento > 0 && (
                <Box sx={{ flex: tarefasEmAndamento, bgcolor: "warning.main", height: "100%" }} />
              )}
              {pendentes > 0 && (
                <Box sx={{ flex: pendentes, bgcolor: "grey.400", height: "100%" }} />
              )}
            </Stack>
          )
        })()}
      </Box>
    </Paper>
  )
}

/* ------------------------------------------------------------------ */
/*  Componente principal: DashboardScreen                            */
/* ------------------------------------------------------------------ */

const BASE_URL = "http://api.tarefas.localhost"

export default function DashboardScreen(): ReactNode {
  /* -- estado -- */
  const [projetos, setProjetos] = useState<ProjetoExterno[]>([])
  const [tarefasPorAgente, setTarefasPorAgente] = useState<Record<string, TarefaExterna[]>>({})
  const [ultimasAtividades, setUltimasAtividades] = useState<UltimaAtividade[]>([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  /* -- carregar dados -- */
  const carregar = useCallback(async () => {
    setLoading(true)
    setErro(null)

    const ext = new ExternalApiClient({ baseUrl: BASE_URL })

    try {
      // 1. Lista de projetos (GET /api/projects)
      let projetosResp: ProjetoExterno[] = []
      const projRaw = await ext.get("/api/projects") as Record<string, unknown> | undefined
      if (projRaw && Array.isArray(projRaw.projects)) {
        projetosResp = projRaw.projects as ProjetoExterno[]
      } else if (Array.isArray(projRaw)) {
        projetosResp = projRaw as ProjetoExterno[]
      }

      // 2. Tarefas por agente
      const tarefasPorAgente: Record<string, TarefaExterna[]> = {}
      for (const proj of projetosResp) {
        if (!proj.id) continue
        try {
          const tasksRaw = await ext.get(`/api/projects/${proj.id}/tasks`) as unknown
          if (Array.isArray(tasksRaw)) {
            tarefasPorAgente[proj.id] = tasksRaw as TarefaExterna[]
          } else {
            tarefasPorAgente[proj.id] = []
          }
        } catch {
          tarefasPorAgente[proj.id] = []
        }
      }

      // 3. Ultima atividade (opcional)
      let ultimasAtividades: UltimaAtividade[] = []
      try {
        const defRaw = await ext.get("/api/projects") as Record<string, unknown> | undefined
        if (defRaw && Array.isArray(defRaw.lastActivities)) {
          ultimasAtividades = defRaw.lastActivities as UltimaAtividade[]
        }
      } catch {
        // atividade opcional, ignora erro
      }

      setProjetos(projetosResp)
      setTarefasPorAgente(tarefasPorAgente)
      setUltimasAtividades(ultimasAtividades)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao carregar dashboard"
      setErro(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    carregar()
  }, [carregar])

  /* -- dados calculados -- */
  const totalProjetos = projetos.length

  const statsAgente = useMemo(() => {
    const resultados: Array<{ agenteId: string; agenteNome: string; tarefasEmAndamento: number; totalTarefas: number }> = []
    for (const [agenteId, tarefas] of Object.entries(tarefasPorAgente)) {
      const emAndamento = tarefas.filter((t) => t.status === "em_andamento").length
      resultados.push({
        agenteId,
        agenteNome: String(agenteId), // nome viria de lookup se necessario
        tarefasEmAndamento: emAndamento,
        totalTarefas: tarefas.length,
      })
    }
    return resultados
  }, [tarefasPorAgente])

  const totalTarefasEmAndamento = statsAgente.reduce((s, a) => s + a.tarefasEmAndamento, 0)
  const totalTarefas = statsAgente.reduce((s, a) => s + a.totalTarefas, 0)

  /* -- render -- */
  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <CircularProgress data-testid="loading-spinner" />
      </Box>
    )
  }

  if (erro) {
    return (
      <Alert severity="error" data-testid="error-alert">
        Erro ao carregar dashboard: {erro}
        <Box sx={{ mt: 1 }}>
          <Chip label="Tentar novamente" size="small" clickable onClick={carregar} />
        </Box>
      </Alert>
    )
  }

  return (
    <Stack spacing={3} data-testid="dashboard-screen">
      {/* Cabecalho */}
      <Box>
        <Typography variant="h3" component="h1" fontWeight={900}>
          Dashboard do Gerente de Agentes
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>
          Visao geral dos projetos, agentes e tarefas em execucao
        </Typography>
      </Box>

      {/* Cards de resumo */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <CardResumo titulo="Projetos" valor={totalProjetos} icone={<DashboardRounded />} cor="primary" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <CardResumo titulo="Total de tarefas" valor={totalTarefas} icone={<TaskAltRounded />} cor="info" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <CardResumo titulo="Em execucao" valor={totalTarefasEmAndamento} icone={<PlayCircleRounded />} cor="warning" />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <CardResumo titulo="Agentes ativos" valor={statsAgente.length} icone={<SmartToyRounded />} cor="success" />
        </Grid>
      </Grid>

      {/* Lista de agentes com tarefas */}
      <Stack spacing={2}>
        <Typography variant="h5" component="h2" fontWeight={700}>
          Agentes e tarefas
        </Typography>
        {statsAgente.length === 0 ? (
          <Alert severity="info" data-testid="empty-state">Nenhum agente encontrado.</Alert>
        ) : (
          <Grid container spacing={2}>
            {statsAgente.map((ag) => (
              <Grid key={ag.agenteId} size={{ xs: 12, sm: 6, md: 4 }}>
                <CardAgente
                  agenteNome={ag.agenteNome}
                  tarefasEmAndamento={ag.tarefasEmAndamento}
                  totalTarefas={ag.totalTarefas}
                />
              </Grid>
            ))}
          </Grid>
        )}
      </Stack>

      {/* Tarefas em execucao detalhadas */}
      <Stack spacing={2}>
        <Typography variant="h5" component="h2" fontWeight={700}>
          Tarefas em execucao
        </Typography>
        {(() => {
          const todasEmAndamento: TarefaExterna[] = []
          for (const tarefas of Object.values(tarefasPorAgente)) {
            for (const t of tarefas) {
              if (t.status === "em_andamento") {
                todasEmAndamento.push({ ...t, agenteId: t.agenteId })
              }
            }
          }

          if (todasEmAndamento.length === 0) {
            return <Alert severity="info" data-testid="no-running-tasks">Nenhuma tarefa em execucao no momento.</Alert>
          }

          return todasEmAndamento.map((tarefa, idx) => (
            <Paper key={tarefa.id} variant="outlined" data-testid={`running-task-${idx}`}>
              <Box sx={{ p: 2, display: "flex", alignItems: "center", gap: 2 }}>
                {ICON_FOR_STATUS[tarefa.status] ?? <PendingRounded sx={{ fontSize: 18 }} />}
                <Stack flex={1} minWidth={0}>
                  <Typography variant="subtitle2" fontWeight={600} noWrap>
                    {tarefa.titulo}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Agente ID: {tarefa.agenteId} · Prioridade: {tarefa.prioridade}
                  </Typography>
                </Stack>
                <Chip
                  label={STATUS_TAREFA_LABEL[tarefa.status] ?? tarefa.status}
                  size="small"
                  color={STATUS_CHIP[tarefa.status] ?? "default"}
                  data-testid={`task-status-chip-${tarefa.id}`}
                />
              </Box>
            </Paper>
          ))
        })()}
      </Stack>

      {/* Ultima atividade */}
      <Stack spacing={2}>
        <Typography variant="h5" component="h2" fontWeight={700}>
          <HistoryRounded sx={{ verticalAlign: "middle", mr: 0.5, fontSize: 26 }} />
          Ultima atividade
        </Typography>
        {ultimasAtividades.length === 0 ? (
          <Alert severity="info" data-testid="no-activity">Sem atividades recentes.</Alert>
        ) : (
          <Stack spacing={1}>
            {ultimasAtividades.slice(0, 10).map((atv) => (
              <Paper key={atv.id} variant="outlined">
                <Box sx={{ p: 1.5, display: "flex", alignItems: "center", gap: 1.5 }}>
                  {atv.tipo === "tarefa_concluida" ? (
                    <CheckCircleRounded color="success" sx={{ fontSize: 20 }} />
                  ) : atv.tipo === "tarefa_iniciada" ? (
                    <PlayCircleRounded color="warning" sx={{ fontSize: 20 }} />
                  ) : (
                    <HistoryRounded sx={{ fontSize: 20 }} />
                  )}
                  <Stack flex={1}>
                    <Typography variant="body2">{atv.titulo}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Agente: {atv.agenteNome} · {new Date(atv.em).toLocaleString("pt-BR")}
                    </Typography>
                  </Stack>
                </Box>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  )
}
