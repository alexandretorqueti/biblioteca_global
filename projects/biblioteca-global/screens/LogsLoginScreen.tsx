import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Alert, Box, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material"
import type { LogLogin, LogsLoginPage } from "@biblioteca-global/shared"
import type { CustomScreenProps } from "@biblioteca-global/ui"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "biblioteca-global-logs-login"

export function formatarTimestamp(timestamp: string): string {
  const data = new Date(timestamp)
  if (Number.isNaN(data.getTime())) return "—"
  return data.toLocaleString("pt-BR")
}

export function formatarMetodo(metodo: LogLogin["metodo"]): string {
  return metodo === "codigo_email" ? "Código por e-mail" : "Senha"
}

export default function LogsLoginScreen(_props: CustomScreenProps): ReactNode {
  void _props
  const api = useApi()
  const [pagina, setPagina] = useState<LogsLoginPage>({ items: [], total: 0, page: 1, pageSize: 20 })
  const [busca, setBusca] = useState("")
  const [buscaAplicada, setBuscaAplicada] = useState("")
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const carregar = useCallback(async (page: number, search: string) => {
    if (!api) return
    setCarregando(true)
    setErro(null)
    try {
      setPagina(await api.logsLogin.list({ page, pageSize: 20, search: search || undefined }))
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : "Não foi possível carregar o log de logins.")
    } finally {
      setCarregando(false)
    }
  }, [api])

  useEffect(() => { void carregar(1, buscaAplicada) }, [carregar, buscaAplicada])

  const totalPaginas = Math.max(1, Math.ceil(pagina.total / pagina.pageSize))
  return (
    <Stack spacing={2} data-testid="biblioteca-global-logs-login">
      <Box>
        <Typography variant="h4" component="h1" fontWeight={700}>Log de Logins</Typography>
        <Typography color="text.secondary">Consulte os acessos realizados na Biblioteca Global.</Typography>
      </Box>
      <TextField
        label="Buscar por e-mail"
        value={busca}
        onChange={(event) => setBusca(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") setBuscaAplicada(busca.trim()) }}
        size="small"
        sx={{ maxWidth: 420 }}
      />
      {erro && <Alert severity="error">{erro}</Alert>}
      <Paper variant="outlined" sx={{ overflow: "auto" }}>
        {carregando ? <Box sx={{ display: "grid", placeItems: "center", p: 5 }}><CircularProgress /></Box> :
          <Table size="small">
            <TableHead><TableRow><TableCell>Usuário / e-mail</TableCell><TableCell>Data e hora</TableCell><TableCell>Método</TableCell><TableCell>Código</TableCell></TableRow></TableHead>
            <TableBody>{pagina.items.map((log) => <TableRow hover key={log.id}>
              <TableCell>{log.email}</TableCell>
              <TableCell>{formatarTimestamp(log.timestamp)}</TableCell>
              <TableCell>{formatarMetodo(log.metodo)}</TableCell>
              <TableCell sx={{ fontFamily: "monospace" }}>{log.metodo === "codigo_email" ? (log.codigo ?? "—") : "—"}</TableCell>
            </TableRow>)}</TableBody>
          </Table>}
        {!carregando && pagina.items.length === 0 && <Typography sx={{ p: 3 }} color="text.secondary">Nenhum login encontrado.</Typography>}
      </Paper>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="body2" color="text.secondary">{pagina.total} registro(s)</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <button type="button" disabled={pagina.page <= 1 || carregando} onClick={() => void carregar(pagina.page - 1, buscaAplicada)}>Anterior</button>
          <Typography variant="body2">Página {pagina.page} de {totalPaginas}</Typography>
          <button type="button" disabled={pagina.page >= totalPaginas || carregando} onClick={() => void carregar(pagina.page + 1, buscaAplicada)}>Próxima</button>
        </Stack>
      </Stack>
    </Stack>
  )
}
