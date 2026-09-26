import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  CardMedia,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  Stack,
  Typography,
  useTheme,
} from "@mui/material"
import CampaignRounded from "@mui/icons-material/CampaignRounded"
import CalendarTodayRounded from "@mui/icons-material/CalendarTodayRounded"
import InboxRounded from "@mui/icons-material/InboxRounded"
import RefreshRounded from "@mui/icons-material/RefreshRounded"
import WavingHandRounded from "@mui/icons-material/WavingHandRounded"
import CloseRounded from "@mui/icons-material/CloseRounded"
import type { PaginatedResult } from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"
export const componentId = "sistema-adm-global-dashboard"

interface Circular {
  id: number
  titulo: string
  image_url?: string | null
  conteudo: string
  publicado_em: string | null
  autor?: string | null
  ativo?: boolean | null
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
  const theme = useTheme()
  const bundle = useApi()
  const { usuario, projeto } = useAuth()
  const [circulares, setCirculares] = useState<Circular[]>([])
  const [circularAberta, setCircularAberta] = useState<Circular | null>(null)
  const [agora, setAgora] = useState(() => new Date())
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const carregarCirculares = useCallback(async () => {
    if (!bundle || !projeto) return
    setCarregando(true)
    setErro(null)
    try {
      const resultado = await bundle.http.request<PaginatedResult<Circular>>(
        "GET",
        `/${projeto.slug}/circulares`,
        { query: { pageSize: 100 }, auth: "access" },
      )
      setCirculares(resultado.items ?? [])
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível carregar as circulares.")
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto])

  useEffect(() => {
    void carregarCirculares()
  }, [carregarCirculares])

  useEffect(() => {
    const intervalo = window.setInterval(() => setAgora(new Date()), 60_000)
    return () => window.clearInterval(intervalo)
  }, [])

  const dataFormatada = useMemo(
    () =>
      new Intl.DateTimeFormat("pt-BR", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(agora),
    [agora],
  )

  const horaFormatada = useMemo(
    () =>
      new Intl.DateTimeFormat("pt-BR", {
        timeStyle: "short",
      }).format(agora),
    [agora],
  )

  return (
    <Stack spacing={4} data-testid="sistema-adm-global-dashboard">
      {/* ─── Cabeçalho: saudação + data/hora ─── */}
      <Box
        sx={{
          background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
          borderRadius: 3,
          px: { xs: 3, sm: 4 },
          py: { xs: 3, sm: 4 },
          color: "primary.contrastText",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Decorative circles */}
        <Box
          sx={{
            position: "absolute",
            top: -40,
            right: -40,
            width: 160,
            height: 160,
            borderRadius: "50%",
            bgcolor: "rgba(255,255,255,0.08)",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            bottom: -20,
            right: 60,
            width: 80,
            height: 80,
            borderRadius: "50%",
            bgcolor: "rgba(255,255,255,0.05)",
          }}
        />

        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          alignItems={{ xs: "flex-start", sm: "center" }}
          spacing={2}
          sx={{ position: "relative" }}
        >
          <Stack spacing={0.5}>
            <Stack direction="row" spacing={1} alignItems="center">
              <WavingHandRounded sx={{ fontSize: { xs: 24, sm: 28 } }} />
              <Typography
                variant="h5"
                sx={{
                  fontWeight: 700,
                  fontSize: { xs: "1.25rem", sm: "1.5rem" },
                }}
              >
                {saudacao(agora.getHours())}, {usuario?.nome ?? "Usuário"}!
              </Typography>
            </Stack>
            <Typography
              sx={{
                opacity: 0.85,
                fontSize: { xs: "0.875rem", sm: "1rem" },
                pl: { sm: "36px" },
              }}
            >
              Bem-vindo ao Administrador Global.
            </Typography>
          </Stack>

          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            sx={{
              bgcolor: "rgba(255,255,255,0.12)",
              borderRadius: 2,
              px: 2,
              py: 1,
            }}
          >
            <CalendarTodayRounded sx={{ fontSize: 20, opacity: 0.9 }} />
            <Stack>
              <Typography
                sx={{
                  fontSize: { xs: "0.75rem", sm: "0.8125rem" },
                  textTransform: "capitalize",
                  opacity: 0.85,
                  lineHeight: 1.2,
                }}
              >
                {dataFormatada}
              </Typography>
              <Typography
                sx={{
                  fontSize: { xs: "1rem", sm: "1.125rem" },
                  fontWeight: 600,
                  lineHeight: 1.3,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {horaFormatada}
              </Typography>
            </Stack>
          </Stack>
        </Stack>
      </Box>

      {/* ─── Seção de Circulares ─── */}
      <Box>
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          sx={{ mb: 3 }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              height: 40,
              borderRadius: 2,
              bgcolor: "primary.main",
              color: "primary.contrastText",
            }}
          >
            <CampaignRounded sx={{ fontSize: 22 }} />
          </Box>
          <Stack direction="row" spacing={1} alignItems="baseline">
            <Typography variant="h6" fontWeight={700}>
              Circulares
            </Typography>
            {!carregando && !erro && circulares.length > 0 && (
              <Chip
                label={circulares.length}
                size="small"
                color="primary"
                variant="outlined"
                sx={{ fontWeight: 600 }}
              />
            )}
          </Stack>
        </Stack>

        {carregando ? (
          <Stack
            spacing={2}
            alignItems="center"
            justifyContent="center"
            py={8}
            data-testid="dashboard-loading"
          >
            <CircularProgress size={40} />
            <Typography color="text.secondary" variant="body2">
              Carregando circulares…
            </Typography>
          </Stack>
        ) : erro ? (
          <Alert
            severity="error"
            data-testid="dashboard-error"
            action={
              <IconButton
                aria-label="tentar novamente"
                color="inherit"
                size="small"
                onClick={() => void carregarCirculares()}
              >
                <RefreshRounded fontSize="inherit" />
              </IconButton>
            }
            sx={{ alignItems: "center" }}
          >
            {erro}
          </Alert>
        ) : circulares.length === 0 ? (
          <Stack
            spacing={2}
            alignItems="center"
            justifyContent="center"
            py={8}
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              borderStyle: "dashed",
            }}
            data-testid="dashboard-empty"
          >
            <InboxRounded sx={{ fontSize: 48, color: "text.disabled" }} />
            <Typography color="text.secondary" variant="body1" fontWeight={500}>
              Nenhuma circular publicada.
            </Typography>
            <Typography color="text.disabled" variant="body2">
              As circulares publicadas aparecerão aqui.
            </Typography>
          </Stack>
        ) : (
          <Grid container spacing={2.5}>
            {circulares.map((circular) => (
              <Grid key={circular.id} size={{ xs: 12, sm: 6, lg: 4 }}>
                <Card
                  sx={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    transition: "transform 0.2s ease, box-shadow 0.2s ease",
                    "&:hover": {
                      transform: "translateY(-3px)",
                      boxShadow: theme.shadows[6],
                    },
                  }}
                >
                  {circular.image_url ? (
                    <CardMedia
                      component="img"
                      height="160"
                      image={circular.image_url}
                      alt=""
                      sx={{
                        objectFit: "cover",
                        borderBottom: 1,
                        borderBottomColor: "divider",
                      }}
                    />
                  ) : (
                    <Box
                      sx={{
                        height: 100,
                        bgcolor: "action.hover",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderBottom: 1,
                        borderBottomColor: "divider",
                      }}
                    >
                      <CampaignRounded sx={{ fontSize: 36, color: "text.disabled" }} />
                    </Box>
                  )}
                  <CardContent
                    sx={{
                      flexGrow: 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: 1,
                      pb: 1.5,
                    }}
                  >
                    <Typography
                      variant="subtitle1"
                      component="h3"
                      fontWeight={600}
                      sx={{
                        lineHeight: 1.4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {circular.titulo}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {circular.publicado_em ? formatarData(circular.publicado_em) : "—"}
                    </Typography>
                  </CardContent>
                  <CardActions sx={{ px: 2, pb: 2, pt: 0 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => setCircularAberta(circular)}
                      sx={{ borderRadius: 2 }}
                    >
                      Ler mais
                    </Button>
                  </CardActions>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}
      </Box>

      {/* ─── Modal de leitura da circular ─── */}
      <Dialog
        open={circularAberta !== null}
        onClose={() => setCircularAberta(null)}
        fullWidth
        maxWidth="md"
        aria-labelledby="circular-dialog-title"
        PaperProps={{
          sx: {
            borderRadius: 3,
            maxHeight: { xs: "95vh", sm: "90vh" },
          },
        }}
      >
        {circularAberta ? (
          <>
            <DialogTitle
              id="circular-dialog-title"
              sx={{
                fontWeight: 700,
                pr: 6,
                pb: 1,
              }}
            >
              {circularAberta.titulo}
            </DialogTitle>
            <IconButton
              aria-label="fechar"
              onClick={() => setCircularAberta(null)}
              sx={{
                position: "absolute",
                right: 8,
                top: 8,
                color: "text.secondary",
              }}
            >
              <CloseRounded />
            </IconButton>
            <DialogContent dividers sx={{ p: { xs: 2, sm: 3 } }}>
              {circularAberta.image_url ? (
                <Box
                  component="img"
                  src={circularAberta.image_url}
                  alt=""
                  sx={{
                    width: "100%",
                    maxHeight: { xs: 240, sm: 360 },
                    objectFit: "contain",
                    borderRadius: 2,
                    mb: 3,
                    bgcolor: "action.hover",
                  }}
                />
              ) : null}
              <Typography
                variant="body1"
                sx={{
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.7,
                  color: "text.primary",
                }}
              >
                {circularAberta.conteudo}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                display="block"
                sx={{
                  mt: 3,
                  pt: 2,
                  borderTop: 1,
                  borderColor: "divider",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Publicado em: {circularAberta.publicado_em ? formatarData(circularAberta.publicado_em, true) : "—"}
              </Typography>
            </DialogContent>
            <DialogActions sx={{ px: 3, py: 2 }}>
              <Button
                onClick={() => setCircularAberta(null)}
                variant="contained"
                sx={{ borderRadius: 2 }}
              >
                Fechar
              </Button>
            </DialogActions>
          </>
        ) : null}
      </Dialog>
    </Stack>
  )
}
