import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  CardMedia,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  Stack,
  Typography,
} from "@mui/material"
import CampaignRounded from "@mui/icons-material/CampaignRounded"
import type { PaginatedResult } from "@biblioteca-global/shared"
import { useApi } from "../../hooks/useApi"
import { useAuth } from "../../auth/AuthContext"

interface Circular {
  id: number
  titulo: string
  imageUrl?: string | null
  conteudo: string
  publicadoEm: string
}

function formatarData(valor: string, incluirHora = false): string {
  const data = new Date(valor)
  if (Number.isNaN(data.getTime())) return valor
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    ...(incluirHora ? { timeStyle: "short" } : {}),
  }).format(data)
}

function saudacao(hora: number): string {
  if (hora < 12) return "Bom dia"
  if (hora < 18) return "Boa tarde"
  return "Boa noite"
}

export default function SistemaAdmGlobalDashboard(): ReactNode {
  const bundle = useApi()
  const { usuario } = useAuth()
  const [circulares, setCirculares] = useState<Circular[]>([])
  const [circularAberta, setCircularAberta] = useState<Circular | null>(null)
  const [agora, setAgora] = useState(() => new Date())
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const carregarCirculares = useCallback(async () => {
    if (!bundle) return
    setCarregando(true)
    setErro(null)
    try {
      const resultado = await bundle.http.request<PaginatedResult<Circular>>(
        "GET",
        "/circulares",
        { query: { pageSize: 100 }, auth: "access" },
      )
      setCirculares(resultado.items ?? [])
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível carregar as circulares.")
    } finally {
      setCarregando(false)
    }
  }, [bundle])

  useEffect(() => {
    void carregarCirculares()
  }, [carregarCirculares])

  useEffect(() => {
    const intervalo = window.setInterval(() => setAgora(new Date()), 60_000)
    return () => window.clearInterval(intervalo)
  }, [])

  const dataHoraAtual = useMemo(
    () => new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short" }).format(agora),
    [agora],
  )

  return (
    <Stack spacing={4} data-testid="sistema-adm-global-dashboard">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={2}>
        <Box>
          <Typography variant="h4" fontWeight={600}>
            {saudacao(agora.getHours())}, {usuario?.nome ?? "usuário"}!
          </Typography>
          <Typography color="text.secondary">Bem-vindo ao Administrador Global.</Typography>
        </Box>
        <Typography color="text.secondary" textAlign={{ xs: "left", sm: "right" }}>
          {dataHoraAtual}
        </Typography>
      </Stack>

      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <CampaignRounded color="primary" />
          <Typography variant="h5" fontWeight={600}>Circulares</Typography>
        </Stack>

        {carregando ? (
          <Box display="flex" justifyContent="center" p={4} data-testid="dashboard-loading">
            <CircularProgress />
          </Box>
        ) : erro ? (
          <Alert severity="error" data-testid="dashboard-error">{erro}</Alert>
        ) : circulares.length === 0 ? (
          <Typography color="text.secondary" data-testid="dashboard-empty">
            Nenhuma circular publicada.
          </Typography>
        ) : (
          <Grid container spacing={2}>
            {circulares.map((circular) => (
              <Grid key={circular.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <Card sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
                  {circular.imageUrl ? (
                    <CardMedia component="img" height="150" image={circular.imageUrl} alt="" />
                  ) : null}
                  <CardContent sx={{ flexGrow: 1 }}>
                    <Typography variant="h6" component="h3" gutterBottom>{circular.titulo}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {formatarData(circular.publicadoEm)}
                    </Typography>
                  </CardContent>
                  <CardActions>
                    <Button onClick={() => setCircularAberta(circular)}>Ler mais</Button>
                  </CardActions>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}
      </Box>

      <Dialog
        open={circularAberta !== null}
        onClose={() => setCircularAberta(null)}
        fullWidth
        maxWidth="md"
        aria-labelledby="circular-dialog-title"
      >
        {circularAberta ? (
          <>
            <DialogTitle id="circular-dialog-title">{circularAberta.titulo}</DialogTitle>
            <DialogContent dividers>
              {circularAberta.imageUrl ? (
                <Box component="img" src={circularAberta.imageUrl} alt="" sx={{ width: "100%", maxHeight: 360, objectFit: "contain", mb: 2 }} />
              ) : null}
              <Typography sx={{ whiteSpace: "pre-wrap" }}>{circularAberta.conteudo}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 3 }}>
                Publicado em: {formatarData(circularAberta.publicadoEm, true)}
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setCircularAberta(null)}>Fechar</Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </Stack>
  )
}
