/**
 * NotificacoesSino — sino de notificações in-app do usuário logado
 * (gestao-de-tarefas-global — macro #5, subtarefa 5).
 *
 * Montado no slot `actions` do SystemScreen SOMENTE quando
 * `projeto?.slug === "gestao-de-tarefas-global"` — fica FORA de
 * `projects/<slug>/screens/` de propósito: não é tela do registry custom
 * (não toca o contrato de autodescoberta nem o customScreens.test.tsx).
 *
 * Contrato HTTP (endpoints da subtarefa 2 — NotificacoesController):
 * - GET  /:slug/notificacoes                  → { itens, naoLidas }
 * - POST /:slug/notificacoes/:id/lida         → marca uma (badge local -1)
 * - POST /:slug/notificacoes/lidas-todas      → { atualizadas, naoLidas: 0 }
 * (contagem vem embutida no GET — um request a menos no mount).
 *
 * Tempo real: canal `notifications` do RealtimeGateway via RealtimeClient
 * (URL via resolveRealtimeUrl(), ticket HTTP + bearer no padrão do cliente
 * HelpDesk — createHelpDeskClient). Reconexão/resubscribe são internos ao
 * RealtimeClient. A cada `notification.created` revalida badge+lista com um
 * GET (o socket é sinal, a API é fonte de verdade);
 * `notifications.unread.changed` ajusta o badge direto (push de "marcar
 * lida" feito em outra aba).
 *
 * Clique no item: marca lida e, havendo `tarefaId`, navega para a área de
 * tarefas via `bg:navigate` (mesmo evento usado pelos hubs do
 * sistema-adm-global — desacoplado do react-router do shell; o caminho é o
 * path do resource `tarefas` no config do projeto).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Tooltip,
  Typography,
} from "@mui/material"
import { NotificationsNoneRounded } from "@mui/icons-material"
import { RealtimeClient } from "@biblioteca-global/api-client"
import type { ApiHttpClient } from "@biblioteca-global/api-client"
import { resolveApiBaseUrl, resolveRealtimeUrl } from "../api/client"

/** Item do sino — espelha NotificacaoItem do backend (subtarefa 2). */
export interface NotificacaoSinoItem {
  id: number
  titulo: string
  corpo: string | null
  tipo: string
  tarefaId: number | null
  lida: boolean
  criadoEm: string
}

/** Assinatura mínima do realtime injetável em teste (fake sem WebSocket). */
export interface SinoRealtimeHandlers {
  /** `notification.created` → revalidar badge + lista. */
  onNotificacaoCriada(): void
  /** `notifications.unread.changed` → badge direto. */
  onContagemNaoLidas(contagem: number): void
}

export interface SinoRealtimeSubscription {
  close(): void
}

export interface NotificacoesSinoProps {
  slug: string
  http: Pick<ApiHttpClient, "request">
  getAccessToken(): string | null
  /**
   * Injeção do canal realtime (testes passam um fake). Padrão: RealtimeClient
   * no canal "notifications" com ticket/cookie no padrão HelpDesk.
   */
  criarRealtime?: (handlers: SinoRealtimeHandlers) => SinoRealtimeSubscription
}

const LIMITE_POP = 20

/** Tempo relativo pt-BR ("agora", "há 5 min", "há 3 h", "há 2 d", data). */
export function tempoRelativo(iso: string, agora: number = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const seg = Math.max(0, Math.floor((agora - t) / 1000))
  if (seg < 60) return "agora"
  const min = Math.floor(seg / 60)
  if (min < 60) return `há ${min} min`
  const horas = Math.floor(min / 60)
  if (horas < 24) return `há ${horas} h`
  const dias = Math.floor(horas / 24)
  if (dias < 30) return `há ${dias} d`
  return new Date(t).toLocaleDateString("pt-BR")
}

/** Navegação entre itens do menu do GeradorSistema (contrato do shell). */
function navegarParaTarefa(tarefaId: number): void {
  window.dispatchEvent(
    new CustomEvent("bg:navigate", { detail: { path: "tarefas", tarefaId } }),
  )
}

/** Realtime padrão: canal "notifications" (escopo = usuário da sessão). */
function criarRealtimePadrao(
  getAccessToken: () => string | null,
  handlers: SinoRealtimeHandlers,
): SinoRealtimeSubscription {
  const client = new RealtimeClient({
    url: resolveRealtimeUrl(),
    baseUrl: resolveApiBaseUrl(),
    getAccessToken,
    channel: "notifications",
    onMessage: (mensagem) => {
      if (mensagem.type === "notification.created") handlers.onNotificacaoCriada()
      else if (mensagem.type === "notifications.unread.changed") {
        handlers.onContagemNaoLidas(mensagem.unreadCount)
      }
    },
  })
  void client.connect()
  return { close: () => client.close() }
}

export function NotificacoesSino({
  slug,
  http,
  getAccessToken,
  criarRealtime = (handlers) => criarRealtimePadrao(getAccessToken, handlers),
}: NotificacoesSinoProps): ReactNode {
  const [itens, setItens] = useState<NotificacaoSinoItem[]>([])
  const [naoLidas, setNaoLidas] = useState(0)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const vivaRef = useRef(true)

  /** GET /:slug/notificacoes — badge + pop juntos (fonte de verdade). */
  const revalidar = useCallback(async () => {
    try {
      const dados = await http.request<{
        itens?: NotificacaoSinoItem[]
        naoLidas?: number
      }>("GET", `/${slug}/notificacoes`, { query: { limite: LIMITE_POP } })
      if (!vivaRef.current) return
      setItens(Array.isArray(dados?.itens) ? dados.itens : [])
      setNaoLidas(Number(dados?.naoLidas ?? 0))
    } catch {
      // Sino nunca quebra a aplicação: falha de fetch mantém o último estado.
    }
  }, [http, slug])

  // Mount: contagem inicial + canal realtime (reconexão/resubscribe internos
  // ao RealtimeClient — 1s de backoff no close, 5s na falha de ticket).
  useEffect(() => {
    vivaRef.current = true
    void revalidar()
    const sub = criarRealtime({
      onNotificacaoCriada: () => {
        if (vivaRef.current) void revalidar()
      },
      onContagemNaoLidas: (contagem) => {
        if (vivaRef.current && Number.isFinite(contagem)) {
          setNaoLidas(Math.max(0, contagem))
        }
      },
    })
    return () => {
      vivaRef.current = false
      sub.close()
    }
  }, [revalidar, criarRealtime])

  /** Clique no item: marca lida no servidor + navega quando há tarefa. */
  const abrirNotificacao = useCallback(
    async (item: NotificacaoSinoItem) => {
      if (!item.lida) {
        try {
          await http.request("POST", `/${slug}/notificacoes/${item.id}/lida`)
        } catch {
          // Falha ao marcar lida não bloqueia a navegação; o próximo GET alinha.
        }
        if (!vivaRef.current) return
        setItens((atual) =>
          atual.map((n) => (n.id === item.id ? { ...n, lida: true } : n)),
        )
        setNaoLidas((c) => Math.max(0, c - 1))
      }
      setAnchor(null)
      if (item.tarefaId !== null && item.tarefaId !== undefined) {
        navegarParaTarefa(item.tarefaId)
      }
    },
    [http, slug],
  )

  /** 'Marcar todas lidas' → zera badge imediatamente (estado local + POST). */
  const marcarTodas = useCallback(async () => {
    setNaoLidas(0)
    setItens((atual) => atual.map((n) => ({ ...n, lida: true })))
    try {
      await http.request("POST", `/${slug}/notificacoes/lidas-todas`)
    } catch {
      if (vivaRef.current) void revalidar()
    }
  }, [http, slug, revalidar])

  return (
    <>
      <Tooltip title="Notificações">
        <IconButton
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label={`Notificações (${naoLidas} não lidas)`}
          data-testid="sino-notificacoes"
        >
          <Badge
            badgeContent={naoLidas}
            color="error"
            showZero={false}
            data-testid="sino-badge"
          >
            <NotificationsNoneRounded />
          </Badge>
        </IconButton>
      </Tooltip>

      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width: 380,
              // 360px: nunca estourar a largura do viewport (comportamento
              // idêntico em telas ≥ 404px, onde 380 já cabe).
              maxWidth: "calc(100vw - 24px)",
              maxHeight: 480,
            },
          },
        }}
        data-testid="sino-popover"
      >
        <Box sx={{ px: 2, py: 1.5, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Typography variant="subtitle2">Notificações</Typography>
          <Button
            size="small"
            onClick={() => void marcarTodas()}
            disabled={naoLidas === 0}
            data-testid="marcar-todas-lidas"
          >
            Marcar todas lidas
          </Button>
        </Box>
        <Divider />
        {itens.length === 0 ? (
          <Box sx={{ px: 2, py: 3 }}>
            <Typography variant="body2" color="text.secondary" data-testid="sino-vazio">
              Nenhuma notificação.
            </Typography>
          </Box>
        ) : (
          <List dense sx={{ maxHeight: 380, overflow: "auto", py: 0 }}>
            {itens.map((item) => (
              <ListItemButton
                key={item.id}
                onClick={() => void abrirNotificacao(item)}
                data-testid={`notificacao-${item.id}`}
                sx={{ alignItems: "flex-start" }}
              >
                {!item.lida && (
                  <Box
                    aria-label="não lida"
                    data-testid={`nao-lida-${item.id}`}
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: "error.main",
                      mt: 1,
                      mr: 1,
                      flexShrink: 0,
                    }}
                  />
                )}
                <ListItemText
                  primary={item.titulo}
                  primaryTypographyProps={{ variant: "body2", fontWeight: item.lida ? 400 : 600 }}
                  secondary={
                    <Box component="span" sx={{ display: "block" }}>
                      {item.corpo ? `${item.corpo} · ` : ""}
                      <Typography component="span" variant="caption" color="text.secondary">
                        {tempoRelativo(item.criadoEm)}
                      </Typography>
                    </Box>
                  }
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  )
}

export default NotificacoesSino
