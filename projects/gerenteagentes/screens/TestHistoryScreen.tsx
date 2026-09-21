import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Alert, Box, Chip, CircularProgress, Collapse, IconButton, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material"
import { KeyboardArrowDown, KeyboardArrowUp } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "gerenteagentes-test-history"

type Failure = {
  id: number
  classification: "new" | "pre_existing" | "resolved" | "worsened" | "flaky_or_inconclusive" | "unclassified"
  suite: string
  test_case?: string | null
  normalized_message: string
  raw_excerpt?: string | null
}

type TestRun = {
  id: number
  phase: string
  status: string
  comparison_status: string
  projeto_nome?: string | null
  tarefa_titulo?: string | null
  commit_sha: string
  branch_name: string
  started_at: string
  finished_at: string
  passed_count?: number | null
  failed_count?: number | null
  failure_count?: number | string
  failures: Failure[]
}

const classificationColor = (value: Failure["classification"]): "error" | "warning" | "success" | "default" =>
  value === "new" || value === "worsened" ? "error" : value === "pre_existing" ? "warning" : value === "resolved" ? "success" : "default"

function RunRow({ run }: { run: TestRun }): ReactNode {
  const [open, setOpen] = useState(false)
  return <>
    <TableRow hover>
      <TableCell><IconButton size="small" onClick={() => setOpen(value => !value)} aria-label="Detalhar execução">{open ? <KeyboardArrowUp /> : <KeyboardArrowDown />}</IconButton></TableCell>
      <TableCell>{new Date(run.started_at).toLocaleString("pt-BR")}</TableCell>
      <TableCell>{run.projeto_nome ?? "—"}</TableCell>
      <TableCell>{run.tarefa_titulo ?? "—"}</TableCell>
      <TableCell><Chip size="small" label={run.phase} /></TableCell>
      <TableCell><Chip size="small" color={run.status === "passed" ? "success" : "error"} label={run.status} /></TableCell>
      <TableCell>{run.comparison_status}</TableCell>
      <TableCell>{run.passed_count ?? "—"} / {run.failed_count ?? run.failure_count ?? 0}</TableCell>
      <TableCell sx={{ fontFamily: "monospace" }}>{run.commit_sha.slice(0, 10)}</TableCell>
    </TableRow>
    <TableRow><TableCell colSpan={9} sx={{ p: 0, border: 0 }}><Collapse in={open} unmountOnExit>
      <Stack spacing={1.5} sx={{ p: 2, bgcolor: "background.default" }}>
        <Typography variant="body2"><strong>Branch:</strong> {run.branch_name}</Typography>
        {run.failures.length === 0 ? <Alert severity="success">Nenhuma falha registrada.</Alert> : run.failures.map(failure =>
          <Paper key={failure.id} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1} alignItems="center"><Chip size="small" color={classificationColor(failure.classification)} label={failure.classification} /><Typography fontWeight={700}>{failure.suite}{failure.test_case ? ` › ${failure.test_case}` : ""}</Typography></Stack>
            <Typography variant="body2" sx={{ mt: 1 }}>{failure.normalized_message}</Typography>
            {failure.raw_excerpt && <Box component="pre" sx={{ m: 0, mt: 1, p: 1, overflow: "auto", bgcolor: "action.hover", fontSize: 12, whiteSpace: "pre-wrap" }}>{failure.raw_excerpt}</Box>}
          </Paper>)}
      </Stack>
    </Collapse></TableCell></TableRow>
  </>
}

export default function TestHistoryScreen(): ReactNode {
  const api = useApi()
  const [runs, setRuns] = useState<TestRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const health = useMemo(() => {
    const latestByProject = new Map<string, TestRun>()
    for (const run of runs) {
      const key = run.projeto_nome ?? "sem-projeto"
      if (!latestByProject.has(key)) latestByProject.set(key, run)
    }
    const latest = [...latestByProject.values()]
    return {
      projects: latest.length,
      healthy: latest.filter(run => run.status === "passed" && Number(run.failure_count ?? 0) === 0).length,
      blocked: latest.filter(run => run.status !== "passed" || Number(run.failure_count ?? 0) > 0).length,
      inconclusive: latest.filter(run => run.comparison_status === "inconclusive").length,
    }
  }, [runs])
  useEffect(() => {
    if (!api) return
    let active = true
    void api.http.request<{ items: TestRun[] }>("GET", "/gerenteagentes/test-runs?limit=200", { auth: "access" })
      .then(result => { if (active) setRuns(result.items ?? []) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar o histórico.") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api])
  return <Stack spacing={2} data-testid="test-history-screen">
    <Box><Typography variant="h4" fontWeight={700}>Saúde e histórico de testes</Typography><Typography color="text.secondary">Baselines, validações pós-DEV, regressões e recuperações executadas pelo Monitor.</Typography></Box>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
      <Chip label={`Projetos observados: ${health.projects}`} />
      <Chip color="success" label={`Gate verde: ${health.healthy}`} />
      <Chip color="error" label={`Deploy bloqueado: ${health.blocked}`} />
      <Chip color="warning" label={`Inconclusivo: ${health.inconclusive}`} />
    </Stack>
    {error && <Alert severity="error">{error}</Alert>}
    <Paper variant="outlined" sx={{ overflow: "auto" }}>
      {loading ? <Box sx={{ display: "grid", placeItems: "center", p: 5 }}><CircularProgress /></Box> : runs.length === 0 ? <Typography sx={{ p: 3 }} color="text.secondary">Nenhuma execução registrada.</Typography> :
        <Table size="small"><TableHead><TableRow><TableCell /><TableCell>Início</TableCell><TableCell>Projeto</TableCell><TableCell>Tarefa</TableCell><TableCell>Fase</TableCell><TableCell>Status</TableCell><TableCell>Comparação</TableCell><TableCell>Passou / falhou</TableCell><TableCell>Commit</TableCell></TableRow></TableHead><TableBody>{runs.map(run => <RunRow key={run.id} run={run} />)}</TableBody></Table>}
    </Paper>
  </Stack>
}
