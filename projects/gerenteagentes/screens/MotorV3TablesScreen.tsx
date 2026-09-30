import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material"
import { PlayArrowRounded, SaveRounded, BlockRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "gerenteagentes-motor-v3-tabelas"

const grupos = [
  { label: "Catálogo de regras", tables: [{ key: "events", label: "Eventos" }, { key: "patterns", label: "Padrões" }, { key: "primitives", label: "Primitivas" }, { key: "actions", label: "Ações" }, { key: "reactions", label: "Reações" }] },
  { label: "Estado operacional", tables: [{ key: "occurrences", label: "Ocorrências" }, { key: "promotionState", label: "Estado de promoção" }, { key: "modelCooldown", label: "Cooldown de modelos" }] },
  { label: "Observabilidade", tables: [{ key: "proposals", label: "Propostas / histórico" }, { key: "eventLog", label: "Log de eventos" }] },
  { label: "Saúde de testes", tables: [{ key: "testRuns", label: "Execuções de testes" }, { key: "testFailures", label: "Falhas normalizadas" }, { key: "testRecovery", label: "Recuperações do Monitor" }] },
]
const tabelas = grupos.flatMap((grupo) => grupo.tables)
const entidadesEditaveis = new Set(["events", "patterns", "actions", "reactions"])
type Row = Record<string, unknown>
type Api = { http: { request: <T>(method: string, path: string, options?: Record<string, unknown>) => Promise<T> } }

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function jsonValue(value: unknown): string {
  return value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function parseJson(value: string, field: string): unknown {
  if (!value.trim()) return null
  try { return JSON.parse(value) } catch { throw new Error(`${field} deve conter JSON válido.`) }
}

function labelFor(table: string): string {
  return tabelas.find((item) => item.key === table)?.label ?? table
}

function ruleText(event: Row, reactions: Row[], actions: Row[]): string {
  const actionById = new Map(actions.map((action) => [String(action.id), action]))
  const chain = reactions
    .filter((reaction) => String(reaction.eventId ?? reaction.event_id) === String(event.id))
    .sort((a, b) => Number(a.occurrence ?? 0) - Number(b.occurrence ?? 0))
    .map((reaction) => {
      const action = actionById.get(String(reaction.actionId ?? reaction.action_id))
      const occurrence = Number(reaction.occurrence ?? 0)
      return `${occurrence}ª vez → ${String(action?.name ?? action?.code ?? "ação não encontrada")}`
    })
  return chain.length ? chain.join("; ") : "Sem reações ativas configuradas."
}

function editorFields(entity: string, draft: Row, setDraft: (next: Row) => void): ReactNode {
  const text = (key: string, label: string, multiline = false) => (
    <TextField
      key={key}
      label={label}
      value={jsonValue(draft[key])}
      multiline={multiline}
      minRows={multiline ? 4 : undefined}
      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      fullWidth
      size="small"
    />
  )
  if (entity === "events") return <>{text("code", "Código")}{text("name", "Nome")}{text("category", "Categoria")}{text("scope", "Escopo")}{text("priority", "Prioridade")}</>
  if (entity === "patterns") return <>{text("eventId", "ID do evento")}{text("pattern", "Padrão")}{text("matchType", "Tipo: contains, exact ou regex")}{text("matchTarget", "Alvo: code, message, stack ou action_result")}</>
  if (entity === "actions") return <>{text("code", "Código")}{text("name", "Nome")}{text("primitivesJson", "Primitivas (JSON)", true)}{text("onPartialFailure", "Falha parcial")}{text("compensationActionId", "ID da compensação")}{text("isTerminal", "Terminal (0 ou 1)")}</>
  return <>{text("eventId", "ID do evento")}{text("occurrence", "Ocorrência")}{text("actionId", "ID da ação")}{text("conditionJson", "Condição (JSON)", true)}{text("paramsJson", "Parâmetros (JSON)", true)}</>
}

export default function MotorV3TablesScreen(): ReactNode {
  const api = useApi() as Api | undefined
  const [table, setTable] = useState(tabelas[0]?.key ?? "")
  const [rows, setRows] = useState<Row[]>([])
  const [catalog, setCatalog] = useState<Record<string, Row[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState(0)
  const [editing, setEditing] = useState<Row | null>(null)
  const [simulation, setSimulation] = useState({ code: "", message: "", stack: "", actionResult: "", occurrence: "1" })
  const [simulationResult, setSimulationResult] = useState<Row | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [saving, setSaving] = useState(false)

  const request = useCallback(async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!api) throw new Error("API indisponível.")
    return api.http.request<T>(method, path, { auth: "access", ...(body === undefined ? {} : { body }) })
  }, [api])

  const loadTable = useCallback(async (selected: string) => {
    if (!api) return
    setLoading(true); setError(null)
    try {
      const result = await request<{ items?: Row[] }>("GET", `/gerenteagentes/motor-v3/tabelas/${selected}`)
      setRows(result.items ?? [])
    } catch (cause) {
      setRows([]); setError(cause instanceof Error ? cause.message : "Não foi possível carregar a tabela.")
    } finally { setLoading(false) }
  }, [api, request])

  const loadCatalog = useCallback(async () => {
    if (!api) return
    try {
      const entries = await Promise.all(["events", "patterns", "actions", "reactions", "occurrences", "promotionState", "proposals"].map(async (name) => {
        const result = await request<{ items?: Row[] }>("GET", `/gerenteagentes/motor-v3/tabelas/${name}`)
        return [name, result.items ?? []] as const
      }))
      setCatalog(Object.fromEntries(entries))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o catálogo.")
    }
  }, [api, request])

  useEffect(() => { void loadTable(table); void loadCatalog() }, [loadCatalog, loadTable, table])

  const eventRows = catalog.events ?? []
  const actionRows = catalog.actions ?? []
  const reactionRows = catalog.reactions ?? []
  const occurrenceRows = catalog.occurrences ?? []
  const conflictRows = (catalog.promotionState ?? []).filter((row) => Number(row.dirty ?? 0) === 1 || Boolean(row.conflictFilesJson ?? row.conflict_files_json))
  const historyRows = useMemo(() => (catalog.proposals ?? []).filter((row) => {
    const proposal = row.proposalJson ?? row.proposal_json
    return proposal && typeof proposal === "object" && (proposal as Row).entity
  }), [catalog.proposals])
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))

  const startEdit = (row: Row) => {
    setEditing({ ...row, primitivesJson: row.primitivesJson ?? row.primitives_json, conditionJson: row.conditionJson ?? row.condition_json, paramsJson: row.paramsJson ?? row.params_json })
    setError(null); setNotice(null)
  }

  const save = async () => {
    if (!editing || editing.id === undefined) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const payload = { ...editing }
      delete payload.id; delete payload.createdAt; delete payload.updatedAt; delete payload.created_at; delete payload.updated_at
      if (table === "actions") payload.primitivesJson = parseJson(String(payload.primitivesJson ?? ""), "Primitivas")
      if (table === "reactions") { payload.conditionJson = parseJson(String(payload.conditionJson ?? ""), "Condição"); payload.paramsJson = parseJson(String(payload.paramsJson ?? ""), "Parâmetros") }
      await request("PATCH", `/gerenteagentes/motor-v3/tabelas/${table}/${editing.id}`, payload)
      setEditing(null); setNotice("Alteração salva e registrada no histórico."); await loadTable(table); await loadCatalog()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a alteração.") }
    finally { setSaving(false) }
  }

  const deactivate = async (row: Row) => {
    if (row.id === undefined || !window.confirm("Desativar esta entrada? Ela não será excluída fisicamente.")) return
    setError(null); setNotice(null)
    try {
      await request("DELETE", `/gerenteagentes/motor-v3/tabelas/${table}/${row.id}`)
      setNotice("Entrada desativada sem exclusão física."); await loadTable(table); await loadCatalog()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível desativar a entrada.") }
  }

  const simulate = async () => {
    setSimulating(true); setError(null)
    try {
      const result = await request<Row>("POST", "/gerenteagentes/motor-v3/simular", { error: simulation, occurrence: Number(simulation.occurrence) || 1 })
      setSimulationResult(result)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível simular a regra.") }
    finally { setSimulating(false) }
  }

  const currentLabel = labelFor(table)
  return <Stack spacing={2} data-testid="motor-v3-tables-screen">
    <Box>
      <Typography variant="h4" fontWeight={700}>Motor v3</Typography>
      <Typography color="text.secondary">Catálogo governável, simulação, histórico e observabilidade operacional.</Typography>
    </Box>
    <Tabs value={view} onChange={(_, next) => setView(next)} aria-label="Visões do Motor v3">
      <Tab label="Tabelas brutas" />
      <Tab label="Regras legíveis" />
      <Tab label="Simular" />
      <Tab label="Ocorrências e conflitos" />
    </Tabs>
    {error && <Alert severity="error">{error}</Alert>}
    {notice && <Alert severity="success">{notice}</Alert>}

    {view === 0 && <>
      <FormControl sx={{ maxWidth: 420 }}>
        <InputLabel id="motor-v3-table-label">Tabela</InputLabel>
        <Select labelId="motor-v3-table-label" label="Tabela" value={table} onChange={(event) => { setRows([]); setTable(event.target.value) }}>
          {grupos.flatMap((grupo) => [<ListSubheader key={`group-${grupo.label}`}>{grupo.label}</ListSubheader>, ...grupo.tables.map((item) => <MenuItem key={item.key} value={item.key}>{item.label}</MenuItem>)])}
        </Select>
      </FormControl>
      <Paper variant="outlined" sx={{ overflow: "auto" }}>
        <Box sx={{ p: 2 }}><Typography variant="h6">{currentLabel}</Typography><Typography variant="body2" color="text.secondary">Até 200 registros mais recentes. A desativação é sempre soft-delete.</Typography></Box>
        {loading ? <Box sx={{ display: "grid", placeItems: "center", p: 5 }}><CircularProgress /> </Box> : rows.length === 0 ? <Typography sx={{ p: 3 }} color="text.secondary">Nenhum registro encontrado.</Typography> : <Table size="small"><TableHead><TableRow>{columns.map((column) => <TableCell key={column} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{column}</TableCell>)}{entidadesEditaveis.has(table) && <TableCell>Ações</TableCell>}</TableRow></TableHead><TableBody>{rows.map((row, index) => <TableRow key={String(row.id ?? index)} hover>{columns.map((column) => <TableCell key={column} sx={{ maxWidth: 420, whiteSpace: "pre-wrap", verticalAlign: "top" }}>{formatValue(row[column])}</TableCell>)}{entidadesEditaveis.has(table) && <TableCell><Stack direction="row" spacing={1}><Button size="small" onClick={() => startEdit(row)}>Editar</Button><Button size="small" color="warning" startIcon={<BlockRounded />} onClick={() => void deactivate(row)}>Desativar</Button></Stack></TableCell>}</TableRow>)}</TableBody></Table>}
      </Paper>
      {editing && <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}><Typography variant="h6">Editar {currentLabel} #{String(editing.id)}</Typography>{editorFields(table, editing, setEditing)}<Stack direction="row" spacing={1}><Button variant="contained" startIcon={<SaveRounded />} disabled={saving} onClick={() => void save()}>Salvar</Button><Button onClick={() => setEditing(null)}>Cancelar</Button></Stack></Stack></Paper>}
    </>}

    {view === 1 && <Stack spacing={2}>{eventRows.filter((event) => Number(event.active ?? 1) === 1).map((event) => <Paper key={String(event.id)} variant="outlined" sx={{ p: 2 }}><Typography variant="h6">{String(event.code)} · {String(event.name)}</Typography><Typography color="text.secondary">{ruleText(event, reactionRows, actionRows)}</Typography><Button sx={{ mt: 1 }} size="small" onClick={() => { setSimulation({ ...simulation, code: String(event.code) }); setView(2) }}>Simular este evento</Button></Paper>)}{eventRows.length === 0 && <Alert severity="info">Nenhum evento ativo carregado.</Alert>}</Stack>}

    {view === 2 && <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}><Typography variant="h6">Simulação dry-run</Typography><Typography variant="body2" color="text.secondary">A simulação não incrementa ocorrências, não executa primitivas e não altera o catálogo.</Typography>{(["code", "message", "stack", "actionResult", "occurrence"] as const).map((field) => <TextField key={field} label={field} value={simulation[field]} onChange={(event) => setSimulation({ ...simulation, [field]: event.target.value })} multiline={field !== "occurrence"} minRows={field !== "occurrence" ? 2 : undefined} fullWidth size="small" />)}<Button variant="contained" startIcon={<PlayArrowRounded />} disabled={simulating} onClick={() => void simulate()}>{simulating ? "Simulando…" : "Simular sem executar"}</Button>{simulationResult && <><Divider /><Typography variant="subtitle1">Resultado</Typography><Box component="pre" sx={{ m: 0, p: 2, overflow: "auto", bgcolor: "action.hover" }}>{JSON.stringify(simulationResult, null, 2)}</Box></>}</Stack></Paper>}

    {view === 3 && <Stack spacing={2}><Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h6">Ocorrências ({occurrenceRows.length})</Typography>{occurrenceRows.length === 0 ? <Typography color="text.secondary">Nenhuma ocorrência registrada ainda.</Typography> : <Table size="small"><TableHead><TableRow><TableCell>Evento</TableCell><TableCell>Tarefa</TableCell><TableCell>Subtarefa</TableCell><TableCell>Geração</TableCell><TableCell>Contagem</TableCell><TableCell>Última ocorrência</TableCell></TableRow></TableHead><TableBody>{occurrenceRows.map((row, index) => <TableRow key={String(row.id ?? index)}><TableCell>{String(row.eventId ?? row.event_id ?? "—")}</TableCell><TableCell>{String(row.tarefaId ?? row.tarefa_id ?? "—")}</TableCell><TableCell>{String(row.subtarefaId ?? row.subtarefa_id ?? "—")}</TableCell><TableCell>{String(row.generation ?? "—")}</TableCell><TableCell>{String(row.count ?? "—")}</TableCell><TableCell>{String(row.lastOccurredAt ?? row.last_occurred_at ?? "—")}</TableCell></TableRow>)}</TableBody></Table>}</Paper><Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h6">Conflitos de promoção ({conflictRows.length})</Typography>{conflictRows.length === 0 ? <Typography color="text.secondary">Nenhum conflito ou estado dirty ativo.</Typography> : conflictRows.map((row, index) => <Alert key={String(row.id ?? index)} severity="warning">Tarefa {String(row.tarefaId ?? row.tarefa_id ?? "—")}: {formatValue(row.conflictFilesJson ?? row.conflict_files_json ?? row.errorMessage ?? row.error_message)}</Alert>)}</Paper><Paper variant="outlined" sx={{ p: 2 }}><Typography variant="h6">Histórico de alterações ({historyRows.length})</Typography>{historyRows.length === 0 ? <Typography color="text.secondary">Nenhuma alteração de catálogo auditada.</Typography> : historyRows.map((row, index) => <Typography key={String(row.id ?? index)} variant="body2">{String(row.createdAt ?? row.created_at ?? "—")} · {String(row.diagnosis ?? "Alteração")} · {formatValue(row.proposalJson ?? row.proposal_json)}</Typography>)}</Paper></Stack>}
  </Stack>
}
