/**
 * PainelPortariaScreen — tela de trabalho contínuo da portaria/triagem.
 *
 * Exibe indicadores de chegadas hoje, aguardando confirmação, prontas para
 * retirada, entregues hoje e pendências antigas. Organiza a lista por estados
 * operacionais: aguardando confirmação, prontas para retirada e exceções.
 *
 * Cada item mostra foto, unidade, transportadora, tempo desde a chegada e
 * status legível. Inclui filtros por condomínio/contexto, localização da
 * unidade, transportadora e período. Busca/escaneamento para localizar
 * encomenda e abrir detalhe de entrega.
 *
 * Ao clicar em item, abre o modal de entrega (EntregaModal) que valida
 * estado e registra a entrega com evidência completa.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Chip,
  CircularProgress,
  Grid,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material"
import {
  Inventory2Rounded,
  SearchRounded,
  HourglassEmptyRounded,
  CheckCircleRounded,
  LocalShippingRounded,
  DoneAllRounded,
  WarningAmberRounded,
  QrCodeScannerRounded,
  FilterListRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"
import { EntregaModal } from "./EntregaModal"

// ============================================================================
// TIPOS
// ============================================================================

type EstadoOperacional =
  | "aguardando_confirmacao"
  | "pronta_retirada"
  | "excecao"
  | "entregue"

type StatusEncomenda = "pendente" | "confirmada" | "entregue" | "cancelada"

interface EncomendaPainelItem {
  id: number
  status: StatusEncomenda
  estadoOperacional: EstadoOperacional
  fotoUrl: string | null
  codigoRastreamento: string | null
  unidadeLabel: string | null
  transportadoraNome: string | null
  minutosDesdeChegada: number
  chegadaEm: string
  confirmadoPorNome: string | null
  confirmadoEm: string | null
  entregueEm: string | null
  observacoes: string | null
}

interface IndicadoresPainel {
  chegadasHoje: number
  aguardandoConfirmacao: number
  prontasParaRetirada: number
  entreguesHoje: number
  pendenciasAntigas: number
}

interface Transportadora {
  id: number
  nome: string
}

// ============================================================================
// CONSTANTES
// ============================================================================

const TAB_ESTADOS = [
  { value: "todas", label: "Fila ativa" },
  { value: "aguardando_confirmacao", label: "Aguardando" },
  { value: "pronta_retirada", label: "Prontas" },
  { value: "excecoes", label: "Exceções" },
] as const

type TabEstado = (typeof TAB_ESTADOS)[number]["value"]

// ============================================================================
// HELPERS
// ============================================================================

function formatarTempoDecorrido(minutos: number): string {
  if (minutos < 1) return "agora"
  if (minutos < 60) return `${minutos}min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `${horas}h ${minutos % 60}min`
  const dias = Math.floor(horas / 24)
  return `${dias}d ${horas % 24}h`
}

function statusLabel(status: StatusEncomenda): string {
  const map: Record<StatusEncomenda, string> = {
    pendente: "Aguardando confirmação",
    confirmada: "Pronta para retirada",
    entregue: "Entregue",
    cancelada: "Cancelada",
  }
  return map[status]
}

function statusColor(
  status: StatusEncomenda,
): "warning" | "success" | "default" | "error" {
  const map: Record<StatusEncomenda, "warning" | "success" | "default" | "error"> = {
    pendente: "warning",
    confirmada: "success",
    entregue: "default",
    cancelada: "error",
  }
  return map[status]
}

// ============================================================================
// COMPONENTE: CardIndicador
// ============================================================================

function CardIndicador({
  titulo,
  valor,
  icone,
  cor,
  testId,
}: {
  titulo: string
  valor: number
  icone: ReactNode
  cor: "primary" | "success" | "warning" | "error" | "info"
  testId?: string
}): ReactNode {
  return (
    <Paper
      variant="outlined"
      data-testid={testId}
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
        <Typography variant="h5" fontWeight={700}>
          {valor}
        </Typography>
      </Box>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE: ItemEncomenda
// ============================================================================

function ItemEncomenda({
  item,
  onClick,
}: {
  item: EncomendaPainelItem
  onClick: (item: EncomendaPainelItem) => void
}): ReactNode {
  const tempoDecorrido = formatarTempoDecorrido(item.minutosDesdeChegada)
  const isPendenciaAntiga =
    item.status === "pendente" && item.minutosDesdeChegada > 3 * 24 * 60

  return (
    <Paper
      variant="outlined"
      data-testid="item-encomenda"
      sx={{
        p: 2,
        cursor: "pointer",
        transition: "all 0.15s ease",
        "&:hover": {
          bgcolor: "action.hover",
          borderColor: "primary.main",
        },
        borderLeft: 4,
        borderLeftColor: isPendenciaAntiga
          ? "error.main"
          : item.status === "confirmada"
            ? "success.main"
            : "warning.main",
      }}
      onClick={() => onClick(item)}
    >
      <Stack direction="row" spacing={2} alignItems="center">
        {/* Foto */}
        <Avatar
          variant="rounded"
          src={item.fotoUrl ?? undefined}
          sx={{
            width: 64,
            height: 64,
            bgcolor: "grey.200",
          }}
        >
          {!item.fotoUrl && <Inventory2Rounded color="disabled" />}
        </Avatar>

        {/* Informações principais */}
        <Box flex={1} minWidth={0}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Typography variant="subtitle2" fontWeight={600}>
              {item.unidadeLabel ?? `Encomenda #${item.id}`}
            </Typography>
            <Chip
              label={statusLabel(item.status)}
              color={statusColor(item.status)}
              size="small"
              variant="outlined"
            />
            {isPendenciaAntiga && (
              <Chip
                icon={<WarningAmberRounded />}
                label="Pendência antiga"
                color="error"
                size="small"
              />
            )}
          </Stack>

          <Stack direction="row" spacing={2} mt={0.5}>
            {item.transportadoraNome && (
              <Typography variant="body2" color="text.secondary">
                <LocalShippingRounded
                  sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }}
                />
                {item.transportadoraNome}
              </Typography>
            )}
            {item.codigoRastreamento && (
              <Typography variant="body2" color="text.secondary">
                #{item.codigoRastreamento}
              </Typography>
            )}
          </Stack>

          {item.confirmadoPorNome && (
            <Typography variant="caption" color="text.secondary">
              Confirmado por {item.confirmadoPorNome}
            </Typography>
          )}
        </Box>

        {/* Tempo decorrido */}
        <Box textAlign="right">
          <Chip
            icon={<HourglassEmptyRounded />}
            label={tempoDecorrido}
            size="small"
            variant="outlined"
            color={isPendenciaAntiga ? "error" : "default"}
          />
        </Box>
      </Stack>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function PainelPortariaScreen(): ReactNode {
  const bundle = useApi()
  const { projeto } = useAuth()

  // Estado da lista
  const [itens, setItens] = useState<EncomendaPainelItem[]>([])
  const [indicadores, setIndicadores] = useState<IndicadoresPainel>({
    chegadasHoje: 0,
    aguardandoConfirmacao: 0,
    prontasParaRetirada: 0,
    entreguesHoje: 0,
    pendenciasAntigas: 0,
  })
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  // Filtros
  const [tabEstado, setTabEstado] = useState<TabEstado>("todas")
  const [busca, setBusca] = useState("")
  const [transportadoraId, setTransportadoraId] = useState<number | null>(null)
  const [localizacao, setLocalizacao] = useState("")
  const [transportadoras, setTransportadoras] = useState<Transportadora[]>([])

  // Modal de entrega
  const [itemSelecionado, setItemSelecionado] = useState<EncomendaPainelItem | null>(null)
  const [modalAberto, setModalAberto] = useState(false)

  // =========================================================================
  // CARREGAR TRANSPORTADORAS (para filtro)
  // =========================================================================

  const carregarTransportadoras = useCallback(async () => {
    if (!bundle || !projeto) return
    try {
      const result = await bundle.http.request<{ items: Transportadora[] }>(
        "GET",
        `/${projeto.slug}/transportadoras`,
        { query: { pageSize: 200 }, auth: "access" },
      )
      setTransportadoras(result.items ?? [])
    } catch {
      // Silencioso — filtro de transportadora ficará vazio
    }
  }, [bundle, projeto])

  // =========================================================================
  // CARREGAR ENCOMENDAS
  // =========================================================================

  const carregarEncomendas = useCallback(async () => {
    if (!bundle || !projeto) return
    setCarregando(true)
    setErro(null)

    try {
      const query: Record<string, string> = {}
      if (tabEstado !== "todas") query.estado = tabEstado
      if (busca.trim()) query.busca = busca.trim()
      if (transportadoraId) query.transportadoraId = String(transportadoraId)
      if (localizacao.trim()) query.localizacao = localizacao.trim()

      const result = await bundle.http.request<{
        itens: EncomendaPainelItem[]
        total: number
        indicadores: IndicadoresPainel
      }>("GET", `/${projeto.slug}/painel-portaria/encomendas`, {
        query,
        auth: "access",
      })

      setItens(result.itens ?? [])
      setIndicadores(result.indicadores ?? indicadores)
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as encomendas.",
      )
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto, tabEstado, busca, transportadoraId, localizacao, indicadores])

  // =========================================================================
  // EFFECTS
  // =========================================================================

  useEffect(() => {
    void carregarTransportadoras()
  }, [carregarTransportadoras])

  useEffect(() => {
    void carregarEncomendas()
  }, [carregarEncomendas])

  // Atualização periódica (30s) para manter painel fresco
  useEffect(() => {
    const intervalo = window.setInterval(() => {
      void carregarEncomendas()
    }, 30_000)
    return () => window.clearInterval(intervalo)
  }, [carregarEncomendas])

  // =========================================================================
  // HANDLERS
  // =========================================================================

  const handleItemClick = useCallback((item: EncomendaPainelItem) => {
    setItemSelecionado(item)
    setModalAberto(true)
  }, [])

  const handleModalClose = useCallback(() => {
    setModalAberto(false)
    setItemSelecionado(null)
  }, [])

  const handleEntregaSucesso = useCallback(() => {
    // Atualiza lista sem recarga completa
    void carregarEncomendas()
  }, [carregarEncomendas])

  // =========================================================================
  // RENDER
  // =========================================================================

  const totalFilaAtiva = useMemo(
    () =>
      indicadores.aguardandoConfirmacao +
      indicadores.prontasParaRetirada +
      indicadores.pendenciasAntigas,
    [indicadores],
  )

  return (
    <Box sx={{ p: 3, maxWidth: 1400, mx: "auto" }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <Inventory2Rounded sx={{ fontSize: 32, color: "primary.main" }} />
        <Box flex={1}>
          <Typography variant="h4" fontWeight={700}>
            Painel da Portaria
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Controle de encomendas em tempo real
          </Typography>
        </Box>
        {totalFilaAtiva > 0 && (
          <Badge badgeContent={totalFilaAtiva} color="error">
            <Chip label="Pendências" variant="outlined" />
          </Badge>
        )}
      </Stack>

      {/* Indicadores */}
      <Grid container spacing={2} mb={3}>
        <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
          <CardIndicador
            titulo="Chegadas hoje"
            valor={indicadores.chegadasHoje}
            icone={<Inventory2Rounded />}
            cor="info"
            testId="indicador-chegadas-hoje"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
          <CardIndicador
            titulo="Aguardando confirmação"
            valor={indicadores.aguardandoConfirmacao}
            icone={<HourglassEmptyRounded />}
            cor="warning"
            testId="indicador-aguardando"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
          <CardIndicador
            titulo="Prontas para retirada"
            valor={indicadores.prontasParaRetirada}
            icone={<CheckCircleRounded />}
            cor="success"
            testId="indicador-prontas"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
          <CardIndicador
            titulo="Entregues hoje"
            valor={indicadores.entreguesHoje}
            icone={<DoneAllRounded />}
            cor="primary"
            testId="indicador-entregues"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 2.4 }}>
          <CardIndicador
            titulo="Pendências antigas"
            valor={indicadores.pendenciasAntigas}
            icone={<WarningAmberRounded />}
            cor="error"
            testId="indicador-pendencias"
          />
        </Grid>
      </Grid>

      {/* Busca e filtros */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap">
          <TextField
            size="small"
            placeholder="Buscar por código, ID ou unidade..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ minWidth: 280 }}
            data-testid="campo-busca"
          />
          <TextField
            size="small"
            select
            label="Transportadora"
            value={transportadoraId ?? ""}
            onChange={(e) =>
              setTransportadoraId(e.target.value ? Number(e.target.value) : null)
            }
            sx={{ minWidth: 200 }}
            SelectProps={{ native: true }}
          >
            <option value="">Todas</option>
            {transportadoras.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </TextField>
          <TextField
            size="small"
            placeholder="Filtrar por localização..."
            value={localizacao}
            onChange={(e) => setLocalizacao(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <FilterListRounded />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ minWidth: 200 }}
            data-testid="campo-localizacao"
          />
          <Tooltip title="Escanear código de barras/QR">
            <IconButton color="primary" data-testid="botao-escanear">
              <QrCodeScannerRounded />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>

      {/* Tabs de estado operacional */}
      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        <Tabs
          value={tabEstado}
          onChange={(_, v) => setTabEstado(v)}
          data-testid="tabs-estados"
        >
          {TAB_ESTADOS.map((tab) => (
            <Tab
              key={tab.value}
              value={tab.value}
              label={tab.label}
              data-testid={`tab-${tab.value}`}
            />
          ))}
        </Tabs>
      </Box>

      {/* Lista de encomendas */}
      {carregando ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : erro ? (
        <Alert severity="error" data-testid="alerta-erro">
          {erro}
        </Alert>
      ) : itens.length === 0 ? (
        <Paper
          variant="outlined"
          sx={{ p: 4, textAlign: "center" }}
          data-testid="estado-vazio"
        >
          <HourglassEmptyRounded
            sx={{ fontSize: 48, color: "text.disabled", mb: 2 }}
          />
          <Typography variant="h6" color="text.secondary">
            {tabEstado === "aguardando_confirmacao"
              ? "Nenhuma encomenda aguardando confirmação"
              : tabEstado === "pronta_retirada"
                ? "Nenhuma encomenda pronta para retirada"
                : tabEstado === "excecoes"
                  ? "Nenhuma exceção ou pendência antiga"
                  : "Nenhuma encomenda na fila ativa"}
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={1}>
            {tabEstado === "todas"
              ? "Encomendas registradas aparecerão aqui conforme chegam."
              : "Ajuste os filtros ou aguarde novas encomendas."}
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={2} data-testid="lista-encomendas">
          {itens.map((item) => (
            <ItemEncomenda
              key={item.id}
              item={item}
              onClick={handleItemClick}
            />
          ))}
        </Stack>
      )}

      {/* Modal de entrega */}
      {itemSelecionado && (
        <EntregaModal
          open={modalAberto}
          onClose={handleModalClose}
          encomendaId={itemSelecionado.id}
          status={itemSelecionado.status}
          onSuccess={handleEntregaSucesso}
        />
      )}
    </Box>
  )
}
