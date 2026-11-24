import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Alert, Box, Chip, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { formatarDuracaoModelo } from "../api/relatorios-medias-modelos"

export const componentId = "gerenteagentes-relatorios-modelos"

type ItemRelatorio = {
  modelo: string
  totalSubtarefas: number
  media: number
  temOutlier: boolean
  maiorDesvio: number
}

/** Relatório Médias Modelos: tempo médio de conclusão de subtarefas por modelo. */
export default function RelatoriosModelosScreen(): ReactNode {
  const api = useApi()
  const [itens, setItens] = useState<ItemRelatorio[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const carregar = useCallback(() => {
    if (!api) return
    setLoading(true)
    setError(null)
    void api.http.request<{ itens: ItemRelatorio[] }>("GET", "/gerenteagentes/relatorios/medias-modelos", { auth: "access" })
      .then(result => setItens(result.itens ?? []))
      .catch(cause => { setError(cause instanceof Error ? cause.message : "Não foi possível carregar o relatório.") })
      .finally(() => { setLoading(false) })
  }, [api])

  useEffect(() => {
    carregar()
  }, [carregar])

  return <Stack spacing={2} data-testid="relatorios-modelos-screen">
    <Box>
      <Typography variant="h4" fontWeight={700}>Médias de Modelos</Typography>
      <Typography color="text.secondary">
        Tempo médio de conclusão de subtarefas por modelo (execuções com mais de 2x a média são
        tratadas como desvio grande e excluídas da média).
      </Typography>
    </Box>

    {error && <Alert severity="error">{error}</Alert>}

    {loading
      ? <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress /></Stack>
      : itens.length === 0 && !error
        ? <Alert severity="info">Nenhum modelo com subtarefas concluídas ainda.</Alert>
        : <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Modelo</TableCell>
                <TableCell>Subtarefas</TableCell>
                <TableCell>Tempo médio</TableCell>
                <TableCell>Desvio grande</TableCell>
                <TableCell>Maior desvio</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {itens.map(item =>
                <TableRow key={item.modelo} hover>
                  <TableCell sx={{ fontFamily: "monospace" }}>{item.modelo}</TableCell>
                  <TableCell>{item.totalSubtarefas}</TableCell>
                  <TableCell>{formatarDuracaoModelo(item.media)}</TableCell>
                  <TableCell>
                    <Chip size="small" color={item.temOutlier ? "warning" : "default"} label={item.temOutlier ? "Sim" : "Não"} />
                  </TableCell>
                  <TableCell>{item.temOutlier ? formatarDuracaoModelo(item.maiorDesvio) : "0"}</TableCell>
                </TableRow>)}
            </TableBody>
          </Table>
        </Paper>}
  </Stack>
}
