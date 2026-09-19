import { useEffect, useState, type ReactNode } from "react"
import { Alert, Box, CircularProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "gerenteagentes-motor-v3-tabelas"

const grupos = [
  { label: "Catálogo de regras", tables: [{ key: "events", label: "Eventos" }, { key: "patterns", label: "Padrões" }, { key: "primitives", label: "Primitivas" }, { key: "actions", label: "Ações" }, { key: "reactions", label: "Reações" }] },
  { label: "Estado operacional", tables: [{ key: "occurrences", label: "Ocorrências" }, { key: "promotionState", label: "Estado de promoção" }, { key: "modelCooldown", label: "Cooldown de modelos" }] },
  { label: "Observabilidade", tables: [{ key: "proposals", label: "Propostas do catálogo" }, { key: "eventLog", label: "Log de eventos" }] },
]
const tabelas = grupos.flatMap((grupo) => grupo.tables)
type Row = Record<string, unknown>

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export default function MotorV3TablesScreen(): ReactNode {
  const api = useApi()
  const [table, setTable] = useState(tabelas[0]?.key ?? "")
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api || !table) return
    let active = true
    setLoading(true); setError(null)
    void api.http.request<{ items?: Row[] }>("GET", `/gerenteagentes/motor-v3/tabelas/${table}`, { auth: "access" })
      .then((result) => { if (active) setRows(result.items ?? []) })
      .catch((cause) => { if (active) { setRows([]); setError(cause instanceof Error ? cause.message : "Não foi possível carregar a tabela.") } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, table])

  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const currentLabel = tabelas.find((item) => item.key === table)?.label ?? table
  return <Stack spacing={2} data-testid="motor-v3-tables-screen">
    <Box><Typography variant="h4" fontWeight={700}>Motor v3</Typography><Typography color="text.secondary">Catálogo de regras, estado operacional e observabilidade. Consulta somente leitura.</Typography></Box>
    <TextField select label="Tabela" value={table} onChange={(event) => { const next = event.target.value; if (tabelas.some((item) => item.key === next)) setTable(next) }} sx={{ maxWidth: 420 }}>
      {grupos.map((grupo) => <Box component="span" key={grupo.label}><Typography component="div" variant="overline" sx={{ px: 2, pt: 1 }}>{grupo.label}</Typography>{grupo.tables.map((item) => <MenuItem key={item.key} value={item.key}>{item.label}</MenuItem>)}</Box>)}
    </TextField>
    {error && <Alert severity="error">{error}</Alert>}
    <Paper variant="outlined" sx={{ overflow: "auto" }}>
      <Box sx={{ p: 2 }}><Typography variant="h6">{currentLabel}</Typography><Typography variant="body2" color="text.secondary">Até 200 registros mais recentes</Typography></Box>
      {loading ? <Box sx={{ display: "grid", placeItems: "center", p: 5 }}><CircularProgress /></Box> : rows.length === 0 ? <Typography sx={{ p: 3 }} color="text.secondary">Nenhum registro encontrado.</Typography> : <Table size="small"><TableHead><TableRow>{columns.map((column) => <TableCell key={column} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{column}</TableCell>)}</TableRow></TableHead><TableBody>{rows.map((row, index) => <TableRow key={String(row.id ?? index)} hover>{columns.map((column) => <TableCell key={column} sx={{ maxWidth: 420, whiteSpace: "pre-wrap", verticalAlign: "top" }}>{formatValue(row[column])}</TableCell>)}</TableRow>)}</TableBody></Table>}
    </Paper>
  </Stack>
}
