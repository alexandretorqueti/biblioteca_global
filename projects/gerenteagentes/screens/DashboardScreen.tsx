/**
 * DashboardScreen — visão do gerente de agentes:
 * - projetos com contagem de tarefas
 * - tarefas em execução
 * - resumo por status
 *
 * Usa api-client (bundle.http) para requisições autenticadas.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Chip, Paper, Stack, Typography, Alert, CircularProgress, Grid } from "@mui/material"
import {
  DashboardRounded,
  SmartToyRounded,
  TaskAltRounded,
  PlayCircleRounded,
  AccountTreeRounded,
} from "@mui/icons-material"
import type { ReactNode } from "react"
import type { PaginatedResult } from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"

/* ------------------------------------------------------------------ */
/*  Tipos                                                              */
/* ------------------------------------------------------------------ */

interface Projeto {
  id: number
  nome: string
  slug: string
  descricao?: string
  ativo: boolean
  agenteId?: number
}

interface Tarefa {
  id: number
  projetoId: number
  agenteId: number
  titulo: string
  status: string
  createdAt: string
}

/* ------------------------------------------------------------------ */
/*  Mapas de estado                                                    */
/* ------------------------------------------------------------------ */

const STATUS_TAREFA_LABEL: Record<string, string> = {
  draft: "Rascunho",
  planned: "Planejada",
  running: "Em execução",
  paused: "Pausada",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
}

const STATUS_CHIP: Record<string, "default" | "success" | "warning" | "error" | "info"> = {
  draft: "default",
  planned: "info",
  running: "warning",
  paused: "default",
  completed: "success",
  failed: "error",
  cancelled: "error",
}

/* ------------------------------------------------------------------ */
/*  Componente: CardResumo                                             */
/* ------------------------------------------------------------------ */

function CardResumo({
  titulo,
  valor,
  icone,
  cor = "primary",
  testId,
}: {
  titulo: string
  valor: number | string
  icone: ReactNode
  cor?: "primary" | "success" | "warning" | "error" | "info"
  testId?: string
}): ReactNode {
  return (
    <Paper
      variant="outlined"
      data-testid={testId ?? "card-resumo"}
      sx={{
        p: 2,
        display: "flex",
        alignItems: "center",
        gap: 2,
        borderLeft: 4,
        borderLeftColor: `${cor}.main`,
      }}
    >
      <Box sx={{ color: `${cor}.main`, display: "flex" }}>{icone}</Box>
      <Box>
        <Typography variant="caption" color="text.secondary">
          {titulo}
        </Typography>
        <Typography variant="h5" fontWeight={600}>
          {valor}
        </Typography>
      </Box>
    </Paper>
  )
}

/* ------------------------------------------------------------------ */
/*  Tela principal                                                     */
/* ------------------------------------------------------------------ */

export default function DashboardScreen(): ReactNode {
  const bundle = useApi()
  const [projetos, setProjetos] = useState<Projeto[]>([])
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    if (!bundle) return
    setLoading(true)
    setErro(null)
    try {
      const [projsResult, tarefasResult] = await Promise.all([
        bundle.http.request<PaginatedResult<Projeto>>("GET", "/projetos_captados", {
          query: { pageSize: 100 },
          auth: "access",
        }),
        bundle.http.request<PaginatedResult<Tarefa>>("GET", "/tarefas", {
          query: { pageSize: 100 },
          auth: "access",
        }),
      ])

      setProjetos(projsResult.items || [])
      setTarefas(tarefasResult.items || [])
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar dados")
    } finally {
      setLoading(false)
    }
  }, [bundle])

  useEffect(() => {
    carregar()
  }, [carregar])

  const stats = useMemo(() => {
    const totalProjetos = projetos.length
    const projetosAtivos = projetos.filter((p) => p.ativo).length
    const totalTarefas = tarefas.length
    const tarefasRunning = tarefas.filter((t) => t.status === "running").length
    const tarefasCompleted = tarefas.filter((t) => t.status === "completed").length
    const tarefasFailed = tarefas.filter((t) => t.status === "failed").length

    return {
      totalProjetos,
      projetosAtivos,
      totalTarefas,
      tarefasRunning,
      tarefasCompleted,
      tarefasFailed,
    }
  }, [projetos, tarefas])

  const tarefasRecentes = useMemo(() => {
    return [...tarefas]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10)
  }, [tarefas])

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="loading-spinner">
        <CircularProgress />
      </Box>
    )
  }

  if (erro) {
    return <Alert severity="error" data-testid="error-alert">{erro}</Alert>
  }

  return (
    <Stack spacing={3} data-testid="dashboard-screen">
      <Typography variant="h4" fontWeight={600}>
        Dashboard
      </Typography>

      {/* Cards de resumo */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <CardResumo
            titulo="Projetos"
            valor={stats.totalProjetos}
            icone={<AccountTreeRounded sx={{ fontSize: 32 }} />}
            cor="primary"
            testId="resumo-projetos"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <CardResumo
            titulo="Projetos Ativos"
            valor={stats.projetosAtivos}
            icone={<AccountTreeRounded sx={{ fontSize: 32 }} />}
            cor="success"
            testId="resumo-projetos-ativos"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <CardResumo
            titulo="Total de Tarefas"
            valor={stats.totalTarefas}
            icone={<TaskAltRounded sx={{ fontSize: 32 }} />}
            cor="info"
            testId="resumo-total-tarefas"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <CardResumo
            titulo="Em Execução"
            valor={stats.tarefasRunning}
            icone={<PlayCircleRounded sx={{ fontSize: 32 }} />}
            cor="warning"
            testId="resumo-running"
          />
        </Grid>
      </Grid>

      {/* Tarefas recentes */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
          <DashboardRounded />
          <Typography variant="h6">Tarefas Recentes</Typography>
        </Stack>

        {tarefasRecentes.length === 0 ? (
          <Typography color="text.secondary" data-testid="empty-state">
            Nenhuma tarefa encontrada
          </Typography>
        ) : (
          <Stack spacing={1}>
            {tarefasRecentes.map((tarefa, indice) => (
              <Paper
                key={tarefa.id}
                variant="outlined"
                data-testid={`running-task-${indice}`}
                sx={{ p: 1.5, display: "flex", alignItems: "center", gap: 1 }}
              >
                <SmartToyRounded sx={{ fontSize: 20, color: "text.secondary" }} />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2" fontWeight={500}>
                    {tarefa.titulo}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Tarefa #{tarefa.id} · Projeto #{tarefa.projetoId} · Agente #{tarefa.agenteId}
                  </Typography>
                </Box>
                <Chip
                  label={STATUS_TAREFA_LABEL[tarefa.status] || tarefa.status}
                  color={STATUS_CHIP[tarefa.status] || "default"}
                  size="small"
                  variant="outlined"
                />
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  )
}
