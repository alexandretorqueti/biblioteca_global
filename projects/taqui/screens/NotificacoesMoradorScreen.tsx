/**
 * NotificacoesMoradorScreen — tela "Minhas Encomendas" do morador.
 *
 * Layout com três seções agrupadas:
 * 1. Aguardando sua confirmação (status: pendente)
 * 2. Prontas para retirada (status: pronta_retirada)
 * 3. Histórico (status: entregue / cancelada)
 *
 * Cada card exibe: foto, transportadora, identificação, data de chegada,
 * unidade e instrução contextual ao status.
 *
 * A ação "Confirmar que reconheço esta encomenda" abre modal de confirmação
 * explícita, chama PATCH de reconhecimento e move o card para "Prontas para
 * retirada". Marcar notificação como lida NÃO altera status da encomenda.
 *
 * Sininho no cabeçalho com badge de não-lidas; ao clicar, painel de
 * notificações recentes com link direto para a encomenda.
 *
 * Permissões:
 * - Morador vê apenas encomendas de suas unidades autorizadas.
 * - Entrega continua sendo ato exclusivo da portaria.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material"
import {
  NotificationsRounded,
  NotificationsActiveRounded,
  Inventory2Rounded,
  CheckCircleRounded,
  LocalShippingRounded,
  EventRounded,
  HourglassEmptyRounded,
  VisibilityRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

export const componentId = "taqui-notificacoes-morador"

// ============================================================================
// TIPOS
// ============================================================================

type StatusEncomenda = "pendente" | "pronta_retirada" | "entregue" | "cancelada"

type TipoNotificacao =
  | "encomenda_pendente"
  | "encomenda_pronta_retirada"
  | "encomenda_entregue"
  | "ocorrencia_registrada"

interface Notificacao {
  id: number
  encomendaId: number
  tipo: TipoNotificacao
  mensagem: string
  lida: boolean
  lidaEm: string | null
  createdAt: string
}

interface Encomenda {
  id: number
  status: StatusEncomenda
  codigoRastreamento: string | null
  transportadoraNome: string | null
  fotoUrl: string | null
  unidadeLabel: string | null
  createdAt: string
  confirmadoEm: string | null
  entregueEm: string | null
  canceladoEm: string | null
  motivoCancelamento: string | null
}

interface MoradorInfo {
  id: number
  nome: string
  unidadeId: number
  unidadeLabel: string | null
}

// ============================================================================
// CONSTANTES
// ============================================================================

const STATUS_LABEL: Record<StatusEncomenda, string> = {
  pendente: "Aguardando sua confirmação",
  pronta_retirada: "Pronta para retirada",
  entregue: "Entregue",
  cancelada: "Cancelada",
}

const STATUS_COLOR: Record<StatusEncomenda, "warning" | "success" | "default" | "error"> = {
  pendente: "warning",
  pronta_retirada: "success",
  entregue: "default",
  cancelada: "error",
}

const STATUS_INSTRUCAO: Record<StatusEncomenda, string> = {
  pendente:
    "Confirme que você reconhece esta encomenda. Isso NÃO significa que você já a retirou — apenas que está ciente da chegada.",
  pronta_retirada:
    "Encomenda reconhecida. Dirija-se à portaria/triagem para retirá-la fisicamente.",
  entregue:
    "Encomenda retirada fisicamente. Se houve algum problema, procure a portaria.",
  cancelada:
    "Esta encomenda foi cancelada e não está mais disponível para retirada.",
}

const TIPO_NOTIFICACAO_LABEL: Record<TipoNotificacao, string> = {
  encomenda_pendente: "Nova encomenda",
  encomenda_pronta_retirada: "Confirmação recebida",
  encomenda_entregue: "Encomenda entregue",
  ocorrencia_registrada: "Ocorrência registrada",
}

// ============================================================================
// HELPERS
// ============================================================================

function formatarData(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatarDataRelativa(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHoras = Math.floor(diffMin / 60)
  const diffDias = Math.floor(diffHoras / 24)

  if (diffMin < 1) return "agora"
  if (diffMin < 60) return `${diffMin}min atrás`
  if (diffHoras < 24) return `${diffHoras}h atrás`
  if (diffDias < 7) return `${diffDias}d atrás`
  return formatarData(iso)
}

// ============================================================================
// COMPONENTE: CardEncomenda
// ============================================================================

function CardEncomenda({
  encomenda,
  onConfirmar,
  confirmandoId,
}: {
  encomenda: Encomenda
  onConfirmar: (id: number) => void
  confirmandoId: number | null
}): ReactNode {
  const isPendente = encomenda.status === "pendente"
  const confirmando = confirmandoId === encomenda.id

  return (
    <Paper
      variant="outlined"
      data-testid="card-encomenda"
      data-status={encomenda.status}
      sx={{
        p: 2,
        borderLeft: 4,
        borderLeftColor:
          encomenda.status === "pronta_retirada"
            ? "success.main"
            : encomenda.status === "entregue"
              ? "action.disabled"
              : encomenda.status === "cancelada"
                ? "error.main"
                : "warning.main",
      }}
    >
      <Stack direction="row" spacing={2} alignItems="flex-start">
        {/* Foto */}
        <Avatar
          variant="rounded"
          src={encomenda.fotoUrl ?? undefined}
          sx={{
            width: 64,
            height: 64,
            bgcolor: "grey.200",
            flexShrink: 0,
          }}
        >
          {!encomenda.fotoUrl && <Inventory2Rounded color="disabled" />}
        </Avatar>

        {/* Conteúdo */}
        <Box flex={1} minWidth={0}>
          {/* Status + identificação */}
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Chip
              label={STATUS_LABEL[encomenda.status]}
              color={STATUS_COLOR[encomenda.status]}
              size="small"
            />
            {encomenda.codigoRastreamento && (
              <Typography variant="caption" color="text.secondary" noWrap>
                #{encomenda.codigoRastreamento}
              </Typography>
            )}
          </Stack>

          {/* Transportadora */}
          {encomenda.transportadoraNome && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.5 }}
              noWrap
            >
              <LocalShippingRounded
                sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }}
              />
              {encomenda.transportadoraNome}
            </Typography>
          )}

          {/* Unidade + chegada */}
          <Stack
            direction="row"
            spacing={2}
            flexWrap="wrap"
            useFlexGap
            sx={{ mt: 0.5 }}
          >
            {encomenda.unidadeLabel && (
              <Typography variant="caption" color="text.secondary">
                <EventRounded
                  sx={{ fontSize: 12, mr: 0.5, verticalAlign: "text-bottom" }}
                />
                {encomenda.unidadeLabel}
              </Typography>
            )}
            <Typography variant="caption" color="text.disabled">
              Chegou em {formatarData(encomenda.createdAt)}
            </Typography>
          </Stack>

          {/* Instrução contextual */}
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mt: 1,
              fontStyle: "italic",
              fontSize: "0.8rem",
            }}
          >
            {STATUS_INSTRUCAO[encomenda.status]}
          </Typography>

          {/* Datas relevantes */}
          {encomenda.status === "pronta_retirada" && encomenda.confirmadoEm && (
            <Typography variant="caption" color="success.dark" sx={{ mt: 0.5, display: "block" }}>
              Reconhecida em {formatarData(encomenda.confirmadoEm)}
            </Typography>
          )}
          {encomenda.status === "entregue" && encomenda.entregueEm && (
            <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: "block" }}>
              Retirada em {formatarData(encomenda.entregueEm)}
            </Typography>
          )}
          {encomenda.status === "cancelada" && encomenda.motivoCancelamento && (
            <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
              <Typography variant="body2">
                <strong>Motivo:</strong> {encomenda.motivoCancelamento}
              </Typography>
            </Alert>
          )}

          {/* Botão de confirmação (apenas pendentes) */}
          {isPendente && (
            <Button
              variant="contained"
              size="small"
              startIcon={
                confirmando ? (
                  <CircularProgress size={16} color="inherit" />
                ) : (
                  <CheckCircleRounded />
                )
              }
              onClick={() => onConfirmar(encomenda.id)}
              disabled={confirmandoId !== null}
              data-testid="botao-confirmar-reconhecimento"
              sx={{ mt: 1.5 }}
            >
              Confirmar que reconheço esta encomenda
            </Button>
          )}
        </Box>
      </Stack>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE: SecaoGroup
// ============================================================================

function SecaoGroup({
  titulo,
  icone,
  cor,
  count,
  children,
  testId,
  defaultExpanded,
}: {
  titulo: string
  icone: ReactNode
  cor: "warning" | "success" | "default" | "error"
  count: number
  children: ReactNode
  testId: string
  defaultExpanded?: boolean
}): ReactNode {
  const [expandida, setExpandida] = useState(defaultExpanded ?? count > 0)

  return (
    <Box data-testid={testId} sx={{ mb: 3 }}>
      {/* Cabeçalho da seção */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          cursor: "pointer",
          py: 1,
          px: 1,
          borderRadius: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
        onClick={() => setExpandida(!expandida)}
        data-testid={`${testId}-header`}
      >
        <Box sx={{ color: `${cor}.main`, display: "flex" }}>{icone}</Box>
        <Typography variant="subtitle1" fontWeight={600} flex={1}>
          {titulo}
        </Typography>
        <Chip
          label={count}
          size="small"
          color={cor === "default" ? undefined : cor}
          variant={count > 0 ? "filled" : "outlined"}
        />
      </Stack>

      {/* Conteúdo */}
      <Collapse in={expandida}>
        {count === 0 ? (
          <Typography
            variant="body2"
            color="text.disabled"
            sx={{ py: 2, px: 1, textAlign: "center" }}
          >
            Nenhuma encomenda nesta categoria.
          </Typography>
        ) : (
          <Stack spacing={2} sx={{ mt: 1 }}>
            {children}
          </Stack>
        )}
      </Collapse>
    </Box>
  )
}

// ============================================================================
// COMPONENTE: DialogConfirmacaoReconhecimento
// ============================================================================

function DialogConfirmacaoReconhecimento({
  open,
  encomenda,
  onConfirmar,
  onCancelar,
  confirmando,
}: {
  open: boolean
  encomenda: Encomenda | null
  onConfirmar: () => void
  onCancelar: () => void
  confirmando: boolean
}): ReactNode {
  if (!encomenda) return null

  return (
    <Dialog
      open={open}
      onClose={onCancelar}
      maxWidth="sm"
      fullWidth
      data-testid="dialog-confirmacao-reconhecimento"
    >
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <CheckCircleRounded color="primary" />
          <Typography variant="h6" fontWeight={600}>
            Confirmar reconhecimento
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body1">
            Você está confirmando que <strong>reconhece</strong> a seguinte encomenda:
          </Typography>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={2} alignItems="center">
              <Avatar
                variant="rounded"
                src={encomenda.fotoUrl ?? undefined}
                sx={{ width: 48, height: 48, bgcolor: "grey.200" }}
              >
                {!encomenda.fotoUrl && <Inventory2Rounded color="disabled" />}
              </Avatar>
              <Box>
                {encomenda.transportadoraNome && (
                  <Typography variant="body2" fontWeight={600}>
                    {encomenda.transportadoraNome}
                  </Typography>
                )}
                {encomenda.codigoRastreamento && (
                  <Typography variant="caption" color="text.secondary">
                    #{encomenda.codigoRastreamento}
                  </Typography>
                )}
                {encomenda.unidadeLabel && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    {encomenda.unidadeLabel}
                  </Typography>
                )}
              </Box>
            </Stack>
          </Paper>

          <Alert severity="info" icon={<VisibilityRounded />}>
            <Typography variant="body2">
              <strong>O que isso significa:</strong> você está avisando a portaria
              que sabe que esta encomenda chegou. A encomenda continuará na
              portaria até que você vá retirá-la fisicamente.
            </Typography>
          </Alert>

          <Alert severity="warning">
            <Typography variant="body2">
              <strong>Atenção:</strong> confirmar o reconhecimento{" "}
              <strong>NÃO</strong> significa que você já retirou a encomenda. A
              retirada física continua sendo feita na portaria/triagem.
            </Typography>
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onCancelar} disabled={confirmando}>
          Cancelar
        </Button>
        <Button
          variant="contained"
          onClick={onConfirmar}
          disabled={confirmando}
          startIcon={
            confirmando ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <CheckCircleRounded />
            )
          }
          data-testid="botao-confirmar-dialog"
        >
          {confirmando ? "Confirmando..." : "Sim, reconheço esta encomenda"}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ============================================================================
// COMPONENTE: PainelNotificacoes (sininho dropdown)
// ============================================================================

function PainelNotificacoes({
  notificacoes,
  naoLidas,
  onMarcarLida,
  onIrParaEncomenda,
  open,
  anchorEl,
  onClose,
}: {
  notificacoes: Notificacao[]
  naoLidas: number
  onMarcarLida: (id: number) => void
  onIrParaEncomenda: (encomendaId: number) => void
  open: boolean
  anchorEl: HTMLElement | null
  onClose: () => void
}): ReactNode {
  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      data-testid="painel-notificacoes"
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 32px)", sm: 380 },
            maxHeight: 480,
          },
        },
      }}
    >
      {/* Cabeçalho */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}
      >
        <NotificationsRounded color="primary" />
        <Typography variant="subtitle1" fontWeight={600} flex={1}>
          Notificações
        </Typography>
        {naoLidas > 0 && (
          <Chip label={`${naoLidas} não lida(s)`} size="small" color="warning" />
        )}
      </Stack>

      {/* Lista */}
      <Box sx={{ maxHeight: 380, overflowY: "auto" }}>
        {notificacoes.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <NotificationsRounded
              sx={{ fontSize: 40, color: "text.disabled", mb: 1 }}
            />
            <Typography variant="body2" color="text.secondary">
              Nenhuma notificação.
            </Typography>
          </Box>
        ) : (
          notificacoes.map((notif) => (
            <Box
              key={notif.id}
              data-testid="item-notificacao"
              sx={{
                px: 2,
                py: 1.5,
                bgcolor: notif.lida ? "transparent" : "action.hover",
                borderLeft: notif.lida ? "none" : "3px solid",
                borderLeftColor: "primary.main",
                cursor: "pointer",
                "&:hover": { bgcolor: "action.selected" },
                borderBottom: 1,
                borderColor: "divider",
              }}
              onClick={() => {
                if (!notif.lida) {
                  onMarcarLida(notif.id)
                }
                onIrParaEncomenda(notif.encomendaId)
                onClose()
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                  variant="body2"
                  fontWeight={notif.lida ? 400 : 600}
                  flex={1}
                >
                  {TIPO_NOTIFICACAO_LABEL[notif.tipo]}
                </Typography>
                {!notif.lida && (
                  <Chip label="Nova" size="small" color="primary" />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" display="block">
                {notif.mensagem}
              </Typography>
              <Typography variant="caption" color="text.disabled">
                {formatarDataRelativa(notif.createdAt)}
              </Typography>
            </Box>
          ))
        )}
      </Box>
    </Popover>
  )
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function NotificacoesMoradorScreen(): ReactNode {
  const bundle = useApi()
  const { projeto, usuario } = useAuth()

  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const [morador, setMorador] = useState<MoradorInfo | null>(null)
  const [notificacoes, setNotificacoes] = useState<Notificacao[]>([])
  const [encomendas, setEncomendas] = useState<Encomenda[]>([])

  // Sininho
  const [sininhoAberto, setSininhoAberto] = useState(false)
  const sininhoRef = useRef<HTMLButtonElement | null>(null)

  // Dialog de confirmação
  const [encomendaParaConfirmar, setEncomendaParaConfirmar] = useState<Encomenda | null>(null)
  const [confirmandoId, setConfirmandoId] = useState<number | null>(null)

  // =========================================================================
  // ENCOMENDAS AGRUPADAS
  // =========================================================================

  const encomendasAguardando = useMemo(
    () => encomendas.filter((e) => e.status === "pendente"),
    [encomendas],
  )
  const encomendasProntas = useMemo(
    () => encomendas.filter((e) => e.status === "pronta_retirada"),
    [encomendas],
  )
  const encomendasHistorico = useMemo(
    () => encomendas.filter((e) => e.status === "entregue" || e.status === "cancelada"),
    [encomendas],
  )
  const notificacoesNaoLidas = useMemo(
    () => notificacoes.filter((n) => !n.lida).length,
    [notificacoes],
  )

  // =========================================================================
  // CARREGAR DADOS DO MORADOR
  // =========================================================================

  const carregarMorador = useCallback(async () => {
    if (!bundle || !projeto || !usuario) return
    try {
      const result = await bundle.http.request<{ items: MoradorInfo[] }>(
        "GET",
        `/${projeto.slug}/moradores`,
        {
          query: { email: usuario.email ?? "", pageSize: 1 },
          auth: "access",
        },
      )
      const primeiroMorador = result.items?.[0]
      if (primeiroMorador) {
        setMorador(primeiroMorador)
      }
    } catch {
      // Silencioso — morador pode não estar vinculado
    }
  }, [bundle, projeto, usuario])

  // =========================================================================
  // CARREGAR NOTIFICAÇÕES
  // =========================================================================

  const carregarNotificacoes = useCallback(async () => {
    if (!bundle || !projeto || !morador) return
    try {
      const result = await bundle.http.request<{ items: Notificacao[] }>(
        "GET",
        `/${projeto.slug}/notificacoes`,
        {
          query: { moradorId: String(morador.id), pageSize: 50 },
          auth: "access",
        },
      )
      setNotificacoes(result.items ?? [])
    } catch {
      // Silencioso
    }
  }, [bundle, projeto, morador])

  // =========================================================================
  // CARREGAR ENCOMENDAS
  // =========================================================================

  const carregarEncomendas = useCallback(async () => {
    if (!bundle || !projeto || !morador) return
    setCarregando(true)
    setErro(null)

    try {
      const result = await bundle.http.request<{ items: Encomenda[] }>(
        "GET",
        `/${projeto.slug}/encomendas`,
        {
          query: { unidadeId: String(morador.unidadeId), pageSize: 100 },
          auth: "access",
        },
      )
      setEncomendas(result.items ?? [])
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as encomendas.",
      )
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto, morador])

  // =========================================================================
  // MARCAR NOTIFICAÇÃO COMO LIDA (NÃO altera status da encomenda)
  // =========================================================================

  const marcarNotificacaoLida = useCallback(
    async (notificacaoId: number) => {
      if (!bundle || !projeto) return
      try {
        await bundle.http.request(
          "PATCH",
          `/${projeto.slug}/notificacoes/${notificacaoId}`,
          {
            body: { lida: true },
            auth: "access",
          },
        )
        setNotificacoes((prev) =>
          prev.map((n) =>
            n.id === notificacaoId
              ? { ...n, lida: true, lidaEm: new Date().toISOString() }
              : n,
          ),
        )
      } catch {
        // Silencioso
      }
    },
    [bundle, projeto],
  )

  // =========================================================================
  // CONFIRMAR RECONHECIMENTO (PATCH — move para pronta_retirada)
  // =========================================================================

  const abrirDialogConfirmacao = useCallback(
    (encomendaId: number) => {
      const enc = encomendas.find((e) => e.id === encomendaId)
      if (enc) {
        setEncomendaParaConfirmar(enc)
      }
    },
    [encomendas],
  )

  const confirmarReconhecimento = useCallback(async () => {
    if (!bundle || !projeto || !morador || !encomendaParaConfirmar) return
    const encomendaId = encomendaParaConfirmar.id
    setConfirmandoId(encomendaId)

    try {
      await bundle.http.request(
        "PATCH",
        `/${projeto.slug}/encomendas/${encomendaId}/reconhecer`,
        {
          body: {
            moradorId: morador.id,
          },
          auth: "access",
        },
      )

      // Atualiza card localmente: move para "pronta_retirada"
      setEncomendas((prev) =>
        prev.map((item) =>
          item.id === encomendaId
            ? {
                ...item,
                status: "pronta_retirada" as StatusEncomenda,
                confirmadoEm: new Date().toISOString(),
              }
            : item,
        ),
      )

      // Atualiza notificações relacionadas
      setNotificacoes((prev) =>
        prev.map((item) =>
          item.encomendaId === encomendaId
            ? {
                ...item,
                tipo: "encomenda_pronta_retirada" as TipoNotificacao,
                lida: true,
                lidaEm: new Date().toISOString(),
              }
            : item,
        ),
      )

      setEncomendaParaConfirmar(null)
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível confirmar o reconhecimento.",
      )
    } finally {
      setConfirmandoId(null)
    }
  }, [bundle, projeto, morador, encomendaParaConfirmar])

  const fecharDialogConfirmacao = useCallback(() => {
    setEncomendaParaConfirmar(null)
  }, [])

  // =========================================================================
  // SININHO
  // =========================================================================

  const abrirSininho = useCallback(() => {
    setSininhoAberto(true)
  }, [])

  const fecharSininho = useCallback(() => {
    setSininhoAberto(false)
  }, [])

  const irParaEncomenda = useCallback((encomendaId: number) => {
    // Scroll to the card by finding it in the DOM
    const cards = document.querySelectorAll("[data-testid='card-encomenda']")
    for (const card of cards) {
      const text = card.textContent ?? ""
      // Simple heuristic: scroll to first card that matches
      if (text.includes(`#${encomendaId}`) || card.querySelector(`[data-encomenda-id="${encomendaId}"]`)) {
        card.scrollIntoView({ behavior: "smooth", block: "center" })
        return
      }
    }
  }, [])

  // =========================================================================
  // EFFECTS
  // =========================================================================

  useEffect(() => {
    void carregarMorador()
  }, [carregarMorador])

  useEffect(() => {
    if (morador) {
      void carregarNotificacoes()
      void carregarEncomendas()
    }
  }, [morador, carregarNotificacoes, carregarEncomendas])

  // =========================================================================
  // RENDER: morador não encontrado
  // =========================================================================

  if (!morador && !carregando) {
    return (
      <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
        <Alert severity="info" data-testid="alerta-morador-nao-vinculado">
          <Typography variant="subtitle2" gutterBottom>
            Vínculo não encontrado
          </Typography>
          <Typography variant="body2">
            Não encontramos um morador vinculado à sua conta. Procure a portaria
            para vincular sua conta ao seu apartamento/casa.
          </Typography>
        </Alert>
      </Box>
    )
  }

  if (!morador) {
    return (
      <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
        <Alert severity="info">
          <Typography variant="subtitle2" gutterBottom>
            Carregando...
          </Typography>
        </Alert>
      </Box>
    )
  }

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 800, mx: "auto" }}>
      {/* Cabeçalho com sininho */}
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        <Box flex={1}>
          <Typography variant="h4" fontWeight={700}>
            Minhas Encomendas
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {morador.nome} — {morador.unidadeLabel ?? `Unidade #${morador.unidadeId}`}
          </Typography>
        </Box>

        {/* Sininho com badge */}
        <Tooltip title="Notificações">
          <IconButton
            ref={sininhoRef}
            onClick={abrirSininho}
            data-testid="botao-sininho"
            color={notificacoesNaoLidas > 0 ? "warning" : "default"}
          >
            <Badge badgeContent={notificacoesNaoLidas} color="warning">
              {notificacoesNaoLidas > 0 ? (
                <NotificationsActiveRounded />
              ) : (
                <NotificationsRounded />
              )}
            </Badge>
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Painel de notificações (popover do sininho) */}
      <PainelNotificacoes
        notificacoes={notificacoes.slice(0, 20)}
        naoLidas={notificacoesNaoLidas}
        onMarcarLida={(id) => void marcarNotificacaoLida(id)}
        onIrParaEncomenda={irParaEncomenda}
        open={sininhoAberto}
        anchorEl={sininhoRef.current}
        onClose={fecharSininho}
      />

      {/* Conteúdo */}
      {carregando ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : erro ? (
        <Alert severity="error" data-testid="alerta-erro">
          {erro}
        </Alert>
      ) : (
        <>
          {/* Seção 1: Aguardando sua confirmação */}
          <SecaoGroup
            titulo="Aguardando sua confirmação"
            icone={<HourglassEmptyRounded />}
            cor="warning"
            count={encomendasAguardando.length}
            testId="secao-aguardando"
            defaultExpanded
          >
            {encomendasAguardando.map((enc) => (
              <CardEncomenda
                key={enc.id}
                encomenda={enc}
                onConfirmar={abrirDialogConfirmacao}
                confirmandoId={confirmandoId}
              />
            ))}
          </SecaoGroup>

          <Divider sx={{ my: 2 }} />

          {/* Seção 2: Prontas para retirada */}
          <SecaoGroup
            titulo="Prontas para retirada"
            icone={<CheckCircleRounded />}
            cor="success"
            count={encomendasProntas.length}
            testId="secao-prontas"
          >
            {encomendasProntas.map((enc) => (
              <CardEncomenda
                key={enc.id}
                encomenda={enc}
                onConfirmar={abrirDialogConfirmacao}
                confirmandoId={confirmandoId}
              />
            ))}
          </SecaoGroup>

          <Divider sx={{ my: 2 }} />

          {/* Seção 3: Histórico */}
          <SecaoGroup
            titulo="Histórico"
            icone={<EventRounded />}
            cor="default"
            count={encomendasHistorico.length}
            testId="secao-historico"
            defaultExpanded={false}
          >
            {encomendasHistorico.map((enc) => (
              <CardEncomenda
                key={enc.id}
                encomenda={enc}
                onConfirmar={abrirDialogConfirmacao}
                confirmandoId={confirmandoId}
              />
            ))}
          </SecaoGroup>
        </>
      )}

      {/* Dialog de confirmação de reconhecimento */}
      <DialogConfirmacaoReconhecimento
        open={encomendaParaConfirmar !== null}
        encomenda={encomendaParaConfirmar}
        onConfirmar={() => void confirmarReconhecimento()}
        onCancelar={fecharDialogConfirmacao}
        confirmando={confirmandoId !== null}
      />
    </Box>
  )
}
