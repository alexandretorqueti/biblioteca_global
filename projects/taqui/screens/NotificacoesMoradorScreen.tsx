/**
 * NotificacoesMoradorScreen — tela do morador para notificações e histórico.
 *
 * Exibe:
 * - Notificações não lidas (sininho) com badge de contagem
 * - Histórico de encomendas da unidade do morador
 * - Histórico de ocorrências das encomendas da unidade
 *
 * Permissões:
 * - Morador vê apenas notificações e encomendas de sua unidade
 * - Ocorrências são exibidas de forma compreensível (tipo, motivo, data, resultado)
 * - Dados sensíveis (foto de evidência interna) podem ser ocultados conforme config
 *
 * Fluxo:
 * 1. Carrega morador autenticado via contexto
 * 2. Busca unidade vinculada ao morador
 * 3. Carrega notificações não lidas da unidade
 * 4. Carrega encomendas da unidade com histórico de ocorrências
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Button,
  Badge,
  Box,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  List,
  ListItemAvatar,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material"
import {
  NotificationsRounded,
  NotificationsActiveRounded,
  Inventory2Rounded,
  WarningAmberRounded,
  CheckCircleRounded,
  ExpandMoreRounded,
  LocalShippingRounded,
  EventRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"

// ============================================================================
// TIPOS
// ============================================================================

type StatusEncomenda = "pendente" | "confirmada" | "entregue" | "cancelada"

interface Notificacao {
  id: number
  encomendaId: number
  tipo: "encomenda_pendente" | "encomenda_confirmada" | "encomenda_entregue" | "ocorrencia_registrada"
  mensagem: string
  lida: boolean
  createdAt: string
}

interface Ocorrencia {
  id: number
  tipo: string
  tipoLabel: string
  motivo: string
  descricao: string | null
  fotoEvidenciaUrl: string | null
  observacoes: string | null
  devolvidaTransportadora: boolean
  dataOcorrencia: string
  registradoPorNome: string
}

interface Encomenda {
  id: number
  status: StatusEncomenda
  codigoRastreamento: string | null
  transportadoraNome: string | null
  fotoUrl: string | null
  createdAt: string
  confirmadoEm: string | null
  entregueEm: string | null
  canceladoEm: string | null
  motivoCancelamento: string | null
  ocorrencias: Ocorrencia[]
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

const TABS = [
  { value: "notificacoes", label: "Notificações" },
  { value: "encomendas", label: "Minhas Encomendas" },
] as const

type TabValue = (typeof TABS)[number]["value"]

const TIPO_NOTIFICACAO_LABEL: Record<Notificacao["tipo"], string> = {
  encomenda_pendente: "Nova encomenda",
  encomenda_confirmada: "Confirmação recebida",
  encomenda_entregue: "Encomenda entregue",
  ocorrencia_registrada: "Ocorrência registrada",
}

const TIPO_NOTIFICACAO_ICONE: Record<Notificacao["tipo"], ReactNode> = {
  encomenda_pendente: <Inventory2Rounded color="primary" />,
  encomenda_confirmada: <CheckCircleRounded color="success" />,
  encomenda_entregue: <CheckCircleRounded color="action" />,
  ocorrencia_registrada: <WarningAmberRounded color="warning" />,
}

const STATUS_LABEL: Record<StatusEncomenda, string> = {
  pendente: "Aguardando confirmação",
  confirmada: "Pronta para retirada",
  entregue: "Entregue",
  cancelada: "Cancelada",
}

const STATUS_COLOR: Record<StatusEncomenda, "warning" | "success" | "default" | "error"> = {
  pendente: "warning",
  confirmada: "success",
  entregue: "default",
  cancelada: "error",
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
// COMPONENTE: ItemNotificacao
// ============================================================================

function ItemNotificacao({
  notificacao,
  onMarcarLida,
}: {
  notificacao: Notificacao
  onMarcarLida: (id: number) => void
}): ReactNode {
  return (
    <ListItemButton
      data-testid="item-notificacao"
      onClick={() => !notificacao.lida && onMarcarLida(notificacao.id)}
      sx={{
        bgcolor: notificacao.lida ? "transparent" : "action.hover",
        borderLeft: notificacao.lida ? "none" : "3px solid",
        borderLeftColor: notificacao.tipo === "ocorrencia_registrada" ? "warning.main" : "primary.main",
      }}
    >
      <ListItemAvatar>
        <Avatar sx={{ bgcolor: "transparent" }}>
          {TIPO_NOTIFICACAO_ICONE[notificacao.tipo]}
        </Avatar>
      </ListItemAvatar>
      <ListItemText
        primary={
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="subtitle2" fontWeight={notificacao.lida ? 400 : 600}>
              {TIPO_NOTIFICACAO_LABEL[notificacao.tipo]}
            </Typography>
            {!notificacao.lida && (
              <Chip label="Nova" size="small" color="primary" />
            )}
          </Stack>
        }
        secondary={
          <Stack spacing={0.5}>
            <Typography variant="body2" color="text.secondary">
              {notificacao.mensagem}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {formatarDataRelativa(notificacao.createdAt)}
            </Typography>
          </Stack>
        }
      />
    </ListItemButton>
  )
}

// ============================================================================
// COMPONENTE: ItemOcorrencia
// ============================================================================

function ItemOcorrencia({ ocorrencia }: { ocorrencia: Ocorrencia }): ReactNode {
  const [expandido, setExpandido] = useState(false)

  return (
    <Paper
      variant="outlined"
      data-testid="item-ocorrencia"
      sx={{
        p: 2,
        borderLeft: 4,
        borderLeftColor: "warning.main",
      }}
    >
      <Stack direction="row" alignItems="flex-start" spacing={2}>
        <WarningAmberRounded color="warning" sx={{ mt: 0.5 }} />
        <Box flex={1}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Chip
              label={ocorrencia.tipoLabel}
              size="small"
              color="warning"
              variant="outlined"
            />
            {ocorrencia.devolvidaTransportadora && (
              <Chip
                label="Devolvida"
                size="small"
                color="error"
                variant="outlined"
              />
            )}
            <Typography variant="caption" color="text.secondary">
              <EventRounded sx={{ fontSize: 12, mr: 0.5, verticalAlign: "text-bottom" }} />
              {formatarData(ocorrencia.dataOcorrencia)}
            </Typography>
          </Stack>

          <Typography variant="body2" sx={{ mt: 1 }}>
            <strong>Motivo:</strong> {ocorrencia.motivo}
          </Typography>

          {ocorrencia.descricao && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              <strong>Descrição:</strong> {ocorrencia.descricao}
            </Typography>
          )}

          <Typography variant="caption" color="text.disabled" sx={{ mt: 1, display: "block" }}>
            Registrado por: {ocorrencia.registradoPorNome}
          </Typography>

          {(ocorrencia.observacoes || ocorrencia.fotoEvidenciaUrl) && (
            <>
              <IconButton
                size="small"
                onClick={() => setExpandido(!expandido)}
                sx={{ mt: 1 }}
                data-testid="btn-expandir-ocorrencia"
              >
                <ExpandMoreRounded
                  sx={{
                    transform: expandido ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}
                />
              </IconButton>
              <Collapse in={expandido}>
                <Stack spacing={1} sx={{ mt: 1 }}>
                  {ocorrencia.observacoes && (
                    <Typography variant="body2" color="text.secondary">
                      <strong>Observações:</strong> {ocorrencia.observacoes}
                    </Typography>
                  )}
                  {ocorrencia.fotoEvidenciaUrl && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Foto de evidência disponível
                      </Typography>
                    </Box>
                  )}
                </Stack>
              </Collapse>
            </>
          )}
        </Box>
      </Stack>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE: ItemEncomenda
// ============================================================================

function ItemEncomenda({ encomenda, onConfirmar }: { encomenda: Encomenda; onConfirmar: (id: number) => void }): ReactNode {
  const [expandido, setExpandido] = useState(false)
  const temOcorrencias = encomenda.ocorrencias.length > 0

  return (
    <Paper
      variant="outlined"
      data-testid="item-encomenda"
      sx={{
        p: 2,
        borderLeft: 4,
        borderLeftColor:
          encomenda.status === "entregue"
            ? "success.main"
            : encomenda.status === "cancelada"
              ? "error.main"
              : "warning.main",
      }}
    >
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <Avatar
          variant="rounded"
          src={encomenda.fotoUrl ?? undefined}
          sx={{
            width: 56,
            height: 56,
            bgcolor: "grey.200",
          }}
        >
          {!encomenda.fotoUrl && <Inventory2Rounded color="disabled" />}
        </Avatar>

        <Box flex={1}>
          <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
            <Chip
              label={STATUS_LABEL[encomenda.status]}
              color={STATUS_COLOR[encomenda.status]}
              size="small"
            />
            {temOcorrencias && (
              <Chip
                icon={<WarningAmberRounded />}
                label={`${encomenda.ocorrencias.length} ocorrência(s)`}
                size="small"
                color="warning"
                variant="outlined"
              />
            )}
            {encomenda.codigoRastreamento && (
              <Typography variant="caption" color="text.secondary">
                #{encomenda.codigoRastreamento}
              </Typography>
            )}
          </Stack>

          {encomenda.transportadoraNome && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              <LocalShippingRounded sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }} />
              {encomenda.transportadoraNome}
            </Typography>
          )}

          <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: "block" }}>
            Registrada em {formatarData(encomenda.createdAt)}
          </Typography>

          {encomenda.status === "pendente" && (
            <Button
              variant="contained"
              size="small"
              startIcon={<CheckCircleRounded />}
              onClick={() => onConfirmar(encomenda.id)}
              data-testid="botao-confirmar-recebimento"
              sx={{ mt: 1.5 }}
            >
              Confirmar recebimento
            </Button>
          )}

          {encomenda.status === "cancelada" && encomenda.motivoCancelamento && (
            <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
              <Typography variant="body2">
                <strong>Motivo do cancelamento:</strong> {encomenda.motivoCancelamento}
              </Typography>
            </Alert>
          )}

          {/* Botão para expandir ocorrências */}
          {temOcorrencias && (
            <>
              <IconButton
                size="small"
                onClick={() => setExpandido(!expandido)}
                sx={{ mt: 1 }}
                data-testid="btn-expandir-encomenda"
              >
                <ExpandMoreRounded
                  sx={{
                    transform: expandido ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}
                />
              </IconButton>
              <Collapse in={expandido}>
                <Stack spacing={2} sx={{ mt: 2 }}>
                  <Divider />
                  <Typography variant="subtitle2" color="text.secondary">
                    Histórico de Ocorrências
                  </Typography>
                  {encomenda.ocorrencias.map((ocorrencia) => (
                    <ItemOcorrencia key={ocorrencia.id} ocorrencia={ocorrencia} />
                  ))}
                </Stack>
              </Collapse>
            </>
          )}
        </Box>
      </Stack>
    </Paper>
  )
}

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================

export default function NotificacoesMoradorScreen(): ReactNode {
  const bundle = useApi()
  const { projeto, usuario } = useAuth()

  const [tab, setTab] = useState<TabValue>("notificacoes")
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const [morador, setMorador] = useState<MoradorInfo | null>(null)
  const [notificacoes, setNotificacoes] = useState<Notificacao[]>([])
  const [encomendas, setEncomendas] = useState<Encomenda[]>([])

  // =========================================================================
  // CARREGAR DADOS DO MORADOR
  // =========================================================================

  const carregarMorador = useCallback(async () => {
    if (!bundle || !projeto || !usuario) return
    try {
      // Busca morador pelo userId (vínculo via email ou tabela auxiliar)
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
    setCarregando(true)
    setErro(null)

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
    } catch (error) {
      setErro(
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as notificações.",
      )
    } finally {
      setCarregando(false)
    }
  }, [bundle, projeto, morador])

  // =========================================================================
  // CARREGAR ENCOMENDAS COM OCORRÊNCIAS
  // =========================================================================

  const carregarEncomendas = useCallback(async () => {
    if (!bundle || !projeto || !morador) return
    setCarregando(true)
    setErro(null)

    try {
      // Busca encomendas da unidade do morador
      const result = await bundle.http.request<{ items: Encomenda[] }>(
        "GET",
        `/${projeto.slug}/encomendas`,
        {
          query: { unidadeId: String(morador.unidadeId), pageSize: 50 },
          auth: "access",
        },
      )

      const encomendasList = result.items ?? []

      // Para cada encomenda, busca ocorrências
      const encomendasComOcorrencias = await Promise.all(
        encomendasList.map(async (enc) => {
          try {
            const ocorrenciasResult = await bundle.http.request<Ocorrencia[]>(
              "GET",
              `/${projeto.slug}/ocorrencias/encomenda/${enc.id}`,
              { auth: "access" },
            )
            return { ...enc, ocorrencias: ocorrenciasResult ?? [] }
          } catch {
            return { ...enc, ocorrencias: [] }
          }
        }),
      )

      setEncomendas(encomendasComOcorrencias)
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
  // MARCAR NOTIFICAÇÃO COMO LIDA
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
          prev.map((n) => (n.id === notificacaoId ? { ...n, lida: true } : n)),
        )
      } catch {
        // Silencioso — falha ao marcar como lida
      }
    },
    [bundle, projeto],
  )

  const confirmarRecebimento = useCallback(async (encomendaId: number) => {
    if (!bundle || !projeto || !morador) return
    try {
      await bundle.http.request("PUT", `/${projeto.slug}/encomendas/${encomendaId}`, {
        body: {
          status: "confirmada",
          confirmadoPorId: morador.id,
          confirmadoEm: new Date().toISOString(),
        },
        auth: "access",
      })
      setEncomendas((prev) => prev.map((item) => item.id === encomendaId
        ? { ...item, status: "confirmada", confirmadoEm: new Date().toISOString() }
        : item))
      setNotificacoes((prev) => prev.map((item) => item.encomendaId === encomendaId
        ? { ...item, tipo: "encomenda_confirmada", lida: true }
        : item))
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível confirmar o recebimento.")
    }
  }, [bundle, projeto, morador])

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
  // COMPUTED
  // =========================================================================

  const notificacoesNaoLidas = useMemo(
    () => notificacoes.filter((n) => !n.lida).length,
    [notificacoes],
  )

  // =========================================================================
  // RENDER
  // =========================================================================

  if (!morador) {
    return (
      <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
        <Alert severity="info" data-testid="alerta-sem-vinculo">
          <Typography variant="body1">
            <strong>Vínculo não encontrado</strong>
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Não foi possível localizar seu cadastro de morador. Entre em contato
            com a portaria para vincular sua conta ao seu apartamento/casa.
          </Typography>
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ p: 3, maxWidth: 800, mx: "auto" }}>
      {/* Cabeçalho */}
      <Stack direction="row" alignItems="center" spacing={2} mb={3}>
        {notificacoesNaoLidas > 0 ? (
          <NotificationsActiveRounded sx={{ fontSize: 32, color: "warning.main" }} />
        ) : (
          <NotificationsRounded sx={{ fontSize: 32, color: "primary.main" }} />
        )}
        <Box flex={1}>
          <Typography variant="h4" fontWeight={700}>
            Minhas Notificações
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {morador.nome} — {morador.unidadeLabel ?? `Unidade #${morador.unidadeId}`}
          </Typography>
        </Box>
        {notificacoesNaoLidas > 0 && (
          <Badge badgeContent={notificacoesNaoLidas} color="warning">
            <Chip label="Não lidas" variant="outlined" />
          </Badge>
        )}
      </Stack>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} data-testid="tabs-notificacoes">
          {TABS.map((t) => (
            <Tab
              key={t.value}
              value={t.value}
              label={
                t.value === "notificacoes" && notificacoesNaoLidas > 0
                  ? `${t.label} (${notificacoesNaoLidas})`
                  : t.label
              }
              data-testid={`tab-${t.value}`}
            />
          ))}
        </Tabs>
      </Box>

      {/* Conteúdo */}
      {carregando ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      ) : erro ? (
        <Alert severity="error" data-testid="alerta-erro">
          {erro}
        </Alert>
      ) : tab === "notificacoes" ? (
        notificacoes.length === 0 ? (
          <Paper
            variant="outlined"
            sx={{ p: 4, textAlign: "center" }}
            data-testid="estado-vazio-notificacoes"
          >
            <NotificationsRounded sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
            <Typography variant="h6" color="text.secondary">
              Nenhuma notificação
            </Typography>
            <Typography variant="body2" color="text.secondary" mt={1}>
              Você receberá notificações quando novas encomendas forem registradas
              para sua unidade.
            </Typography>
          </Paper>
        ) : (
          <Paper variant="outlined">
            <List disablePadding>
              {notificacoes.map((notificacao, index) => (
                <Box key={notificacao.id}>
                  {index > 0 && <Divider />}
                  <ItemNotificacao
                    notificacao={notificacao}
                    onMarcarLida={marcarNotificacaoLida}
                  />
                </Box>
              ))}
            </List>
          </Paper>
        )
      ) : encomendas.length === 0 ? (
        <Paper
          variant="outlined"
          sx={{ p: 4, textAlign: "center" }}
          data-testid="estado-vazio-encomendas"
        >
          <Inventory2Rounded sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            Nenhuma encomenda
          </Typography>
          <Typography variant="body2" color="text.secondary" mt={1}>
            Não há encomendas registradas para sua unidade no momento.
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={2} data-testid="lista-encomendas">
              {encomendas.map((encomenda) => (
            <ItemEncomenda key={encomenda.id} encomenda={encomenda} onConfirmar={(id) => void confirmarRecebimento(id)} />
          ))}
        </Stack>
      )}
    </Box>
  )
}
