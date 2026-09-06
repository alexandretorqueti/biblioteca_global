/**
 * RegistroEncomendaScreen — tela custom de registro rápido de encomendas.
 *
 * Fluxo otimizado para portaria/triagem:
 * 1. Busca de unidade por label/endereço/nome do morador (Autocomplete com debounce).
 * 2. Confirmação visual: card com identificação amigável + moradores ativos.
 * 3. Seleção de transportadora por busca com indicador de recorrência.
 * 4. Captura de foto (câmera ou arquivo) com prévia, substituir e remover.
 * 5. Leitura de código de barras/QR pela câmera com fallback manual.
 * 6. Campo de observação opcional.
 * 7. Seleção do funcionário que está registrando.
 * 8. Registro → confirmação com unidade, horário, foto e resultado da notificação.
 * 9. "Registrar próxima" mantém funcionário e transportadora, limpa o resto.
 *
 * Estados: loading (carregando dados iniciais), empty (sem resultados na busca),
 * error (falha recuperável), success (confirmação pós-registro).
 *
 * Responsiva (Stack column em mobile, row em desktop) e navegável por teclado.
 * Não exibe IDs técnicos — apenas identificação amigável.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react"
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  type SelectChangeEvent,
} from "@mui/material"
import { useTheme } from "@mui/material/styles"
import {
  CameraAltRounded,
  CheckCircleRounded,
  CloseRounded,
  DeleteRounded,
  HomeRounded,
  Inventory2Rounded,
  LocalShippingRounded,
  NotificationImportantRounded,
  PersonRounded,
  PhotoCameraRounded,
  QrCodeScannerRounded,
  RefreshRounded,
  SaveRounded,
  SearchRounded,
  WarningAmberRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

// ============================================================================
// TIPOS
// ============================================================================

interface UnidadeBusca {
  id: number
  label: string | null
  tipo: "apartamento" | "casa"
  rua: string | null
  bloco: string | null
  andar: number | null
  numero: string | null
  quadra: string | null
  lote: string | null
  moradores: Array<{ id: number; nome: string; ativo: boolean }>
}

interface TransportadoraBusca {
  id: number
  nome: string
  cnpj: string | null
  telefone: string | null
  frequencia: number
}

interface Funcionario {
  id: number
  nome: string
  funcao: "triagem" | "portaria" | "ambos"
  ativo: boolean
}

interface RegistroResult {
  encomenda: Record<string, unknown>
  notificacao: {
    enviada: boolean
    totalMoradores: number
    erro?: string
    fotoExcecao?: string
  }
}

type TelaEstado = "form" | "success"

// ============================================================================
// HELPERS
// ============================================================================

/** Formata a label amigável da unidade sem expor IDs técnicos. */
function formatarLabelUnidade(unidade: UnidadeBusca): string {
  if (unidade.label) return unidade.label
  const partes: string[] = []
  if (unidade.rua) partes.push(`Rua ${unidade.rua}`)
  if (unidade.tipo === "apartamento") {
    if (unidade.bloco) partes.push(`Bloco ${unidade.bloco}`)
    if (unidade.andar) partes.push(`${unidade.andar}º andar`)
    if (unidade.numero) partes.push(`Apto ${unidade.numero}`)
  } else {
    if (unidade.quadra) partes.push(`Quadra ${unidade.quadra}`)
    if (unidade.lote) partes.push(`Lote ${unidade.lote}`)
  }
  return partes.join(", ") || "Unidade sem identificação"
}

/** Formata data/hora no padrão brasileiro. */
function formatarDataHora(iso: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

/** Debounce hook para busca. */
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

// ============================================================================
// DETECTOR DE CÓDIGO DE BARRAS (tipo local)
// ============================================================================

type Detector = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function RegistroEncomendaScreen(): ReactNode {
  const theme = useTheme()
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"))
  const bundle = useApi()
  const { projeto } = useAuth()

  // ── Estados de dados ────────────────────────────────────────────────
  const [carregandoDados, setCarregandoDados] = useState(true)
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([])
  const [erroDados, setErroDados] = useState<string | null>(null)

  // ── Estados do formulário ───────────────────────────────────────────
  const [unidadeBusca, setUnidadeBusca] = useState("")
  const [unidadeResultados, setUnidadeResultados] = useState<UnidadeBusca[]>([])
  const [unidadeCarregando, setUnidadeCarregando] = useState(false)
  const [unidadeSelecionada, setUnidadeSelecionada] = useState<UnidadeBusca | null>(null)

  const [transportadoraBusca, setTransportadoraBusca] = useState("")
  const [transportadoraResultados, setTransportadoraResultados] = useState<TransportadoraBusca[]>([])
  const [transportadoraCarregando, setTransportadoraCarregando] = useState(false)
  const [transportadoraSelecionada, setTransportadoraSelecionada] = useState<TransportadoraBusca | null>(null)

  const [funcionarioId, setFuncionarioId] = useState<number | "">("")
  const [codigo, setCodigo] = useState("")
  const [observacoes, setObservacoes] = useState("")
  const [fotoFile, setFotoFile] = useState<File | null>(null)
  const [fotoUrl, setFotoUrl] = useState<string | null>(null)

  // ── Câmera ──────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraAtiva, setCameraAtiva] = useState(false)
  const [cameraErro, setCameraErro] = useState<string | null>(null)

  // ── Estados de ação ─────────────────────────────────────────────────
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [telaEstado, setTelaEstado] = useState<TelaEstado>("form")
  const [resultadoRegistro, setResultadoRegistro] = useState<RegistroResult | null>(null)
  const [registroEm, setRegistroEm] = useState<string | null>(null)

  // ── Debounced search terms ──────────────────────────────────────────
  const unidadeBuscaDebounced = useDebounce(unidadeBusca, 300)
  const transportadoraBuscaDebounced = useDebounce(transportadoraBusca, 300)

  // ── Carregar dados iniciais (funcionários) ──────────────────────────
  useEffect(() => {
    if (!bundle || !projeto) return
    let cancelado = false
    const carregar = async () => {
      setCarregandoDados(true)
      setErroDados(null)
      try {
        const result = await bundle.http.request<{ items: Funcionario[] }>(
          "GET",
          `/${projeto.slug}/funcionarios`,
          { query: { pageSize: 200 }, auth: "access" },
        )
        if (!cancelado) {
          setFuncionarios(
            (result.items ?? []).filter((f) => f.ativo !== false),
          )
        }
      } catch (cause) {
        if (!cancelado) {
          setErroDados(
            cause instanceof Error ? cause.message : "Não foi possível carregar os dados da triagem.",
          )
        }
      } finally {
        if (!cancelado) setCarregandoDados(false)
      }
    }
    void carregar()
    return () => { cancelado = true }
  }, [bundle, projeto])

  // ── Busca de unidades com debounce ──────────────────────────────────
  useEffect(() => {
    if (!bundle || !projeto) return
    if (unidadeSelecionada) return // não buscar se já selecionou

    let cancelado = false
    const buscar = async () => {
      setUnidadeCarregando(true)
      try {
        const query: Record<string, string> = { limit: "20", ativo: "true" }
        if (unidadeBuscaDebounced.trim()) {
          query.q = unidadeBuscaDebounced.trim()
        }
        const result = await bundle.http.request<UnidadeBusca[]>(
          "GET",
          `/${projeto.slug}/encomendas-registro/unidades`,
          { query, auth: "access" },
        )
        if (!cancelado) {
          setUnidadeResultados(Array.isArray(result) ? result : [])
        }
      } catch {
        if (!cancelado) setUnidadeResultados([])
      } finally {
        if (!cancelado) setUnidadeCarregando(false)
      }
    }
    void buscar()
    return () => { cancelado = true }
  }, [bundle, projeto, unidadeBuscaDebounced, unidadeSelecionada])

  // ── Busca de transportadoras com debounce ───────────────────────────
  useEffect(() => {
    if (!bundle || !projeto) return
    if (transportadoraSelecionada) return

    let cancelado = false
    const buscar = async () => {
      setTransportadoraCarregando(true)
      try {
        const query: Record<string, string> = { limit: "20" }
        if (transportadoraBuscaDebounced.trim()) {
          query.q = transportadoraBuscaDebounced.trim()
        }
        const result = await bundle.http.request<TransportadoraBusca[]>(
          "GET",
          `/${projeto.slug}/encomendas-registro/transportadoras`,
          { query, auth: "access" },
        )
        if (!cancelado) {
          setTransportadoraResultados(Array.isArray(result) ? result : [])
        }
      } catch {
        if (!cancelado) setTransportadoraResultados([])
      } finally {
        if (!cancelado) setTransportadoraCarregando(false)
      }
    }
    void buscar()
    return () => { cancelado = true }
  }, [bundle, projeto, transportadoraBuscaDebounced, transportadoraSelecionada])

  // ── Cleanup da câmera ───────────────────────────────────────────────
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
    },
    [],
  )

  // ── Foto: selecionar arquivo ────────────────────────────────────────
  const selecionarFoto = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFotoFile(file)
    setFotoUrl(URL.createObjectURL(file))
    // Reset input para permitir selecionar o mesmo arquivo novamente
    event.target.value = ""
  }, [])

  const removerFoto = useCallback(() => {
    if (fotoUrl) URL.revokeObjectURL(fotoUrl)
    setFotoFile(null)
    setFotoUrl(null)
  }, [fotoUrl])

  // ── Câmera: alternar ────────────────────────────────────────────────
  const alternarCamera = useCallback(async () => {
    if (cameraAtiva) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setCameraAtiva(false)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraErro("A câmera não está disponível neste navegador.")
      return
    }
    try {
      setCameraErro(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCameraAtiva(true)
    } catch {
      setCameraErro("Não foi possível acessar a câmera. Você ainda pode anexar uma foto.")
    }
  }, [cameraAtiva])

  // ── Câmera: capturar frame como foto ────────────────────────────────
  const capturarFrame = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        const file = new File([blob], `foto-encomenda-${Date.now()}.jpg`, {
          type: "image/jpeg",
        })
        setFotoFile(file)
        setFotoUrl(URL.createObjectURL(file))
      },
      "image/jpeg",
      0.9,
    )
  }, [])

  // ── Leitura de código de barras/QR ──────────────────────────────────
  const lerCodigo = useCallback(async () => {
    const DetectorClass = (
      window as unknown as { BarcodeDetector?: new (options?: { formats?: string[] }) => Detector }
    ).BarcodeDetector
    const video = videoRef.current
    if (!DetectorClass || !video) {
      setErro("A leitura automática não é suportada neste navegador; digite o código manualmente.")
      return
    }
    try {
      const encontrados = await new DetectorClass({
        formats: ["qr_code", "code_128", "ean_13", "ean_8"],
      }).detect(video)
      const valor = encontrados[0]?.rawValue
      if (valor) {
        setCodigo(valor)
      } else {
        setErro("Nenhum código foi encontrado. Aponte a câmera para o código e tente novamente.")
      }
    } catch {
      setErro("Não foi possível ler o código. Tente novamente ou digite-o manualmente.")
    }
  }, [])

  // ── Registrar encomenda ─────────────────────────────────────────────
  const registrar = useCallback(async () => {
    if (!bundle || !projeto) return
    if (!unidadeSelecionada) {
      setErro("Selecione a unidade de destino.")
      return
    }
    if (funcionarioId === "") {
      setErro("Selecione o funcionário responsável pelo registro.")
      return
    }

    setSalvando(true)
    setErro(null)

    try {
      // Upload da foto se houver arquivo (usa URL do blob como placeholder)
      // Em produção, o upload seria feito via endpoint dedicado; aqui usamos
      // a URL do blob como evidência local.
      const fotoUrlParaEnvio = fotoUrl ?? null

      const result = await bundle.http.request<RegistroResult>(
        "POST",
        `/${projeto.slug}/encomendas-registro`,
        {
          auth: "access",
          body: {
            unidadeId: unidadeSelecionada.id,
            registradoPorId: Number(funcionarioId),
            transportadoraId: transportadoraSelecionada?.id ?? null,
            codigoRastreamento: codigo.trim() || null,
            fotoUrl: fotoUrlParaEnvio,
            observacoes: observacoes.trim() || null,
          },
        },
      )

      setResultadoRegistro(result)
      setRegistroEm(new Date().toISOString())
      setTelaEstado("success")
    } catch (cause) {
      setErro(
        cause instanceof Error ? cause.message : "Não foi possível registrar a encomenda.",
      )
    } finally {
      setSalvando(false)
    }
  }, [
    bundle,
    projeto,
    unidadeSelecionada,
    funcionarioId,
    transportadoraSelecionada,
    codigo,
    fotoUrl,
    observacoes,
  ])

  // ── Registrar próxima (mantém funcionário e transportadora) ─────────
  const registrarProxima = useCallback(() => {
    setTelaEstado("form")
    setResultadoRegistro(null)
    setRegistroEm(null)
    setUnidadeSelecionada(null)
    setUnidadeBusca("")
    setUnidadeResultados([])
    setCodigo("")
    setObservacoes("")
    if (fotoUrl) URL.revokeObjectURL(fotoUrl)
    setFotoFile(null)
    setFotoUrl(null)
    setErro(null)
  }, [fotoUrl])

  // ── Opções de Autocomplete para unidade ─────────────────────────────
  const unidadeOpcoes = useMemo(() => {
    if (unidadeSelecionada) return [unidadeSelecionada]
    return unidadeResultados
  }, [unidadeResultados, unidadeSelecionada])

  // ── Opções de Autocomplete para transportadora ──────────────────────
  const transportadoraOpcoes = useMemo(() => {
    if (transportadoraSelecionada) return [transportadoraSelecionada]
    return transportadoraResultados
  }, [transportadoraResultados, transportadoraSelecionada])

  // ── Loading state ───────────────────────────────────────────────────
  if (carregandoDados) {
    return (
      <Box
        sx={{ p: 3, maxWidth: 760, mx: "auto", textAlign: "center" }}
        data-testid="registro-encomenda-loading"
      >
        <CircularProgress size={48} sx={{ mb: 2 }} />
        <Typography color="text.secondary">Carregando dados da triagem...</Typography>
      </Box>
    )
  }

  // ── Erro de dados iniciais ──────────────────────────────────────────
  if (erroDados && funcionarios.length === 0) {
    return (
      <Box sx={{ p: 3, maxWidth: 760, mx: "auto" }} data-testid="registro-encomenda-erro-dados">
        <Alert
          severity="error"
          icon={<WarningAmberRounded />}
          action={
            <Button
              color="inherit"
              size="small"
              startIcon={<RefreshRounded />}
              onClick={() => window.location.reload()}
            >
              Recarregar
            </Button>
          }
        >
          {erroDados}
        </Alert>
      </Box>
    )
  }

  // ── Tela de sucesso ─────────────────────────────────────────────────
  if (telaEstado === "success" && resultadoRegistro && unidadeSelecionada && registroEm) {
    return (
      <Box sx={{ p: 3, maxWidth: 760, mx: "auto" }} data-testid="registro-encomenda-sucesso">
        <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
          <CheckCircleRounded sx={{ fontSize: 64, color: "success.main", mb: 2 }} />
          <Typography variant="h5" gutterBottom>
            Encomenda registrada com sucesso!
          </Typography>

          <Stack spacing={2} sx={{ mt: 3, textAlign: "left" }}>
            {/* Unidade */}
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <HomeRounded color="primary" />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Destino
                  </Typography>
                  <Typography variant="body1" fontWeight={600}>
                    {formatarLabelUnidade(unidadeSelecionada)}
                  </Typography>
                </Box>
              </Stack>
            </Paper>

            {/* Horário */}
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Inventory2Rounded color="action" />
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Registrado em
                </Typography>
                <Typography variant="body1">{formatarDataHora(registroEm)}</Typography>
              </Box>
            </Stack>

            {/* Transportadora (se houver) */}
            {transportadoraSelecionada && (
              <Stack direction="row" spacing={1.5} alignItems="center">
                <LocalShippingRounded color="action" />
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Transportadora
                  </Typography>
                  <Typography variant="body1">{transportadoraSelecionada.nome}</Typography>
                </Box>
              </Stack>
            )}

            {/* Foto */}
            {fotoUrl && (
              <Box>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  Foto da encomenda
                </Typography>
                <Box
                  component="img"
                  src={fotoUrl}
                  alt="Foto da encomenda registrada"
                  sx={{
                    width: "100%",
                    maxHeight: 200,
                    objectFit: "contain",
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                />
              </Box>
            )}

            {/* Resultado da notificação */}
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: resultadoRegistro.notificacao.enviada
                  ? "success.50"
                  : "warning.50",
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center">
                {resultadoRegistro.notificacao.enviada ? (
                  <NotificationImportantRounded color="success" />
                ) : (
                  <WarningAmberRounded color="warning" />
                )}
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Notificação
                  </Typography>
                  {resultadoRegistro.notificacao.enviada ? (
                    <Typography variant="body1">
                      {resultadoRegistro.notificacao.totalMoradores} morador(es) notificado(s)
                    </Typography>
                  ) : (
                    <Typography variant="body1" color="warning.dark">
                      {resultadoRegistro.notificacao.totalMoradores === 0
                        ? "Nenhum morador ativo na unidade para notificar"
                        : `Falha ao notificar: ${resultadoRegistro.notificacao.erro ?? "erro desconhecido"}`}
                    </Typography>
                  )}
                </Box>
              </Stack>
            </Paper>

            {/* Exceção de foto */}
            {resultadoRegistro.notificacao.fotoExcecao && (
              <Alert severity="info" icon={<PhotoCameraRounded />}>
                {resultadoRegistro.notificacao.fotoExcecao}
              </Alert>
            )}
          </Stack>

          <Divider sx={{ my: 3 }} />

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            justifyContent="center"
          >
            <Button
              variant="contained"
              size="large"
              onClick={registrarProxima}
              startIcon={<Inventory2Rounded />}
              data-testid="botao-registrar-proxima"
              autoFocus
            >
              Registrar próxima
            </Button>
          </Stack>
        </Paper>
      </Box>
    )
  }

  // ── Tela de formulário ──────────────────────────────────────────────
  return (
    <Box sx={{ p: 3, maxWidth: 760, mx: "auto" }} data-testid="registro-encomenda-screen">
      {/* Cabeçalho */}
      <Stack direction="row" spacing={1.5} alignItems="center" mb={3}>
        <Inventory2Rounded color="primary" sx={{ fontSize: 36 }} />
        <Box>
          <Typography variant="h4" component="h1">
            Registrar Encomenda
          </Typography>
          <Typography color="text.secondary">
            Registre a chegada e avise o morador.
          </Typography>
        </Box>
      </Stack>

      {/* Alertas de erro */}
      {erro && (
        <Alert
          severity="error"
          onClose={() => setErro(null)}
          sx={{ mb: 2 }}
          data-testid="alerta-erro-registro"
        >
          {erro}
        </Alert>
      )}
      {cameraErro && (
        <Alert severity="warning" onClose={() => setCameraErro(null)} sx={{ mb: 2 }}>
          {cameraErro}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack spacing={2.5}>
          {/* ── Busca de unidade ─────────────────────────────────────── */}
          <Autocomplete
            options={unidadeOpcoes}
            value={unidadeSelecionada}
            loading={unidadeCarregando}
            getOptionLabel={(option) => formatarLabelUnidade(option)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onInputChange={(_e, newValue) => {
              setUnidadeBusca(newValue)
              if (unidadeSelecionada && newValue !== formatarLabelUnidade(unidadeSelecionada)) {
                setUnidadeSelecionada(null)
              }
            }}
            onChange={(_e: SyntheticEvent, value: UnidadeBusca | null) => {
              setUnidadeSelecionada(value)
            }}
            noOptionsText={
              unidadeBusca.trim()
                ? unidadeCarregando
                  ? "Buscando..."
                  : "Nenhuma unidade encontrada"
                : "Digite para buscar unidades"
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Buscar unidade de destino"
                placeholder="Rua, bloco, apto, quadra, lote ou nome do morador"
                required
                fullWidth
                autoFocus={!isMobile}
                InputProps={{
                  ...params.InputProps,
                  startAdornment: (
                    <>
                      <InputAdornment position="start">
                        <SearchRounded color="action" />
                      </InputAdornment>
                      {params.InputProps.startAdornment}
                    </>
                  ),
                  endAdornment: (
                    <>
                      {unidadeCarregando && (
                        <CircularProgress color="inherit" size={20} />
                      )}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
                inputProps={{
                  ...params.inputProps,
                  "data-testid": "autocomplete-unidade",
                }}
              />
            )}
            renderOption={(props, option) => {
              const moradoresAtivos = option.moradores.filter((m) => m.ativo)
              return (
                <li {...props} key={option.id}>
                  <Box sx={{ py: 0.5 }}>
                    <Typography variant="body1">
                      {formatarLabelUnidade(option)}
                    </Typography>
                    {moradoresAtivos.length > 0 && (
                      <Typography variant="caption" color="text.secondary">
                        {moradoresAtivos.map((m) => m.nome).join(", ")}
                      </Typography>
                    )}
                    {moradoresAtivos.length === 0 && (
                      <Typography variant="caption" color="warning.main">
                        Sem moradores ativos
                      </Typography>
                    )}
                  </Box>
                </li>
              )
            }}
          />

          {/* ── Card de confirmação visual da unidade ────────────────── */}
          {unidadeSelecionada && (
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "primary.50",
                borderColor: "primary.main",
              }}
              data-testid="card-unidade-selecionada"
            >
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <HomeRounded color="primary" />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="subtitle1" fontWeight={600}>
                    {formatarLabelUnidade(unidadeSelecionada)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    {unidadeSelecionada.tipo === "apartamento"
                      ? "Apartamento"
                      : "Casa"}
                  </Typography>

                  {/* Moradores ativos */}
                  {unidadeSelecionada.moradores.filter((m) => m.ativo).length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        Moradores ativos:
                      </Typography>
                      <List dense sx={{ mt: -0.5 }}>
                        {unidadeSelecionada.moradores
                          .filter((m) => m.ativo)
                          .map((m) => (
                            <ListItem key={m.id} sx={{ py: 0 }}>
                              <ListItemAvatar sx={{ minWidth: 36 }}>
                                <Avatar sx={{ width: 24, height: 24 }}>
                                  <PersonRounded sx={{ fontSize: 14 }} />
                                </Avatar>
                              </ListItemAvatar>
                              <ListItemText
                                primary={m.nome}
                                primaryTypographyProps={{ variant: "body2" }}
                              />
                            </ListItem>
                          ))}
                      </List>
                    </Box>
                  )}
                  {unidadeSelecionada.moradores.filter((m) => m.ativo).length === 0 && (
                    <Alert severity="warning" sx={{ mt: 1 }} icon={false}>
                      Nenhuma morador ativo nesta unidade. A notificação não será enviada.
                    </Alert>
                  )}
                </Box>
                <IconButton
                  size="small"
                  onClick={() => {
                    setUnidadeSelecionada(null)
                    setUnidadeBusca("")
                  }}
                  aria-label="Limpar seleção de unidade"
                >
                  <CloseRounded fontSize="small" />
                </IconButton>
              </Stack>
            </Paper>
          )}

          {/* ── Busca de transportadora ──────────────────────────────── */}
          <Autocomplete
            options={transportadoraOpcoes}
            value={transportadoraSelecionada}
            loading={transportadoraCarregando}
            getOptionLabel={(option) => option.nome}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onInputChange={(_e, newValue) => {
              setTransportadoraBusca(newValue)
              if (
                transportadoraSelecionada &&
                newValue !== transportadoraSelecionada.nome
              ) {
                setTransportadoraSelecionada(null)
              }
            }}
            onChange={(_e: SyntheticEvent, value: TransportadoraBusca | null) => {
              setTransportadoraSelecionada(value)
            }}
            noOptionsText={
              transportadoraBusca.trim()
                ? transportadoraCarregando
                  ? "Buscando..."
                  : "Nenhuma transportadora encontrada"
                : "Digite para buscar ou deixe vazio para ver as mais frequentes"
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Loja / Transportadora"
                placeholder="Buscar por nome ou CNPJ"
                fullWidth
                InputProps={{
                  ...params.InputProps,
                  startAdornment: (
                    <>
                      <InputAdornment position="start">
                        <LocalShippingRounded color="action" />
                      </InputAdornment>
                      {params.InputProps.startAdornment}
                    </>
                  ),
                  endAdornment: (
                    <>
                      {transportadoraCarregando && (
                        <CircularProgress color="inherit" size={20} />
                      )}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
                inputProps={{
                  ...params.inputProps,
                  "data-testid": "autocomplete-transportadora",
                }}
              />
            )}
            renderOption={(props, option) => (
              <li {...props} key={option.id}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body1">{option.nome}</Typography>
                    {option.cnpj && (
                      <Typography variant="caption" color="text.secondary">
                        {option.cnpj}
                      </Typography>
                    )}
                  </Box>
                  {option.frequencia > 0 && (
                    <Chip
                      label={`${option.frequencia}× nos últimos 30 dias`}
                      size="small"
                      color="primary"
                      variant="outlined"
                    />
                  )}
                </Stack>
              </li>
            )}
          />

          {/* ── Funcionário que está registrando ─────────────────────── */}
          <FormControl fullWidth required>
            <InputLabel>Registrado por</InputLabel>
            <Select
              label="Registrado por"
              value={funcionarioId}
              onChange={(e: SelectChangeEvent<number | "">) =>
                setFuncionarioId(e.target.value as number | "")
              }
              startAdornment={
                <InputAdornment position="start">
                  <PersonRounded color="action" />
                </InputAdornment>
              }
              inputProps={{ "data-testid": "select-funcionario" }}
            >
              <MenuItem value="">Selecione o funcionário...</MenuItem>
              {funcionarios.map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {f.nome} — {f.funcao}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* ── Código de barras / QR code ───────────────────────────── */}
          <TextField
            label="Código de barras / QR code"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            fullWidth
            placeholder="Escaneie ou digite manualmente"
            inputProps={{ "data-testid": "campo-codigo" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <QrCodeScannerRounded color="action" />
                </InputAdornment>
              ),
            }}
          />

          {/* ── Câmera e leitura de código ───────────────────────────── */}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <Button
              variant="outlined"
              onClick={() => void alternarCamera()}
              startIcon={<CameraAltRounded />}
              data-testid="botao-camera"
            >
              {cameraAtiva ? "Desligar câmera" : "Usar câmera"}
            </Button>
            <Button
              variant="outlined"
              onClick={() => void lerCodigo()}
              startIcon={<QrCodeScannerRounded />}
              disabled={!cameraAtiva}
              data-testid="botao-ler-codigo"
            >
              Ler código
            </Button>
            {cameraAtiva && (
              <Button
                variant="contained"
                onClick={capturarFrame}
                startIcon={<PhotoCameraRounded />}
                data-testid="botao-capturar-foto"
              >
                Capturar foto
              </Button>
            )}
          </Stack>

          {/* Preview da câmera */}
          {cameraAtiva && (
            <Box
              component="video"
              ref={videoRef}
              autoPlay
              playsInline
              sx={{
                width: "100%",
                maxHeight: 280,
                bgcolor: "#111",
                borderRadius: 1,
              }}
              data-testid="preview-camera"
            />
          )}

          {/* ── Foto: prévia, substituir, remover ────────────────────── */}
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="flex-start">
            <Button
              variant="outlined"
              component="label"
              startIcon={<PhotoCameraRounded />}
              data-testid="input-foto"
            >
              {fotoUrl ? "Substituir foto" : "Adicionar foto"}
              <input
                hidden
                type="file"
                accept="image/*"
                capture="environment"
                onChange={selecionarFoto}
              />
            </Button>
            {fotoUrl && (
              <Button
                variant="outlined"
                color="error"
                onClick={removerFoto}
                startIcon={<DeleteRounded />}
                data-testid="botao-remover-foto"
              >
                Remover foto
              </Button>
            )}
          </Stack>

          {/* Preview da foto */}
          {fotoUrl && (
            <Box sx={{ position: "relative" }} data-testid="preview-foto">
              <Box
                component="img"
                src={fotoUrl}
                alt="Foto da encomenda"
                sx={{
                  width: "100%",
                  maxHeight: 280,
                  objectFit: "contain",
                  borderRadius: 1,
                  border: "1px solid",
                  borderColor: "divider",
                }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 0.5, display: "block" }}
              >
                {fotoFile?.name ?? "Foto capturada"}
                {fotoFile && ` — ${(fotoFile.size / 1024).toFixed(0)} KB`}
              </Typography>
            </Box>
          )}

          {/* Aviso se não houver foto */}
          {!fotoUrl && (
            <Alert severity="info" icon={<PhotoCameraRounded />}>
              A foto é a evidência de chegada. Recomendamos capturar antes de registrar.
            </Alert>
          )}

          {/* ── Observações ──────────────────────────────────────────── */}
          <TextField
            label="Observações"
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            multiline
            minRows={2}
            maxRows={5}
            fullWidth
            placeholder="Caixa danificada, tamanho, fragilidade..."
            inputProps={{ maxLength: 2000, "data-testid": "campo-observacoes" }}
          />

          {/* ── Botão de registrar ───────────────────────────────────── */}
          <Button
            variant="contained"
            size="large"
            onClick={() => void registrar()}
            disabled={salvando || !unidadeSelecionada || funcionarioId === ""}
            startIcon={
              salvando ? <CircularProgress size={18} color="inherit" /> : <SaveRounded />
            }
            data-testid="botao-registrar"
          >
            {salvando ? "Registrando..." : "Registrar encomenda"}
          </Button>
        </Stack>
      </Paper>
    </Box>
  )
}