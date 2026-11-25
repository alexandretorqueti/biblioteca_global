/**
 * DashboardScreen — "Minhas Tarefas" do usuário logado (gestao-de-tarefas-global
 * — macro #7, subtarefa 2).
 *
 * Rota INICIAL do projeto (config.ts — grupo "Início", primeiro item): o
 * GeradorSistema usa `firstPath` como rota inicial, então o usuário (tablet
 * sempre aberto / quiosque) cai aqui ao entrar no sistema.
 *
 * Escopo (escopo da subtarefa — nada além):
 * - LISTA: GET `/:slug/tarefas/minhas` (subtarefa 1) via `bundle.http` do
 *   useApi — somente as tarefas em que o colaborador da sessão é o
 *   responsável ativo, nos estados não terminais, na ordem do servidor
 *   (prazo ASC com NULL por último, desempate por prioridade).
 * - CONCLUIR: POST `/:slug/tarefas/:id/concluir` por item (transição da
 *   macro #3 — o backend registra histórico e notificação) com feedback
 *   visual (spinner + disabled durante o request), remoção do item da lista
 *   SEM reload no sucesso e revalidação via GET; erro 403/409 exibe a
 *   mensagem LITERAL da API em Alert.
 * - DESTAQUE: cálculo no front a partir de `prazo` — vencida → cor de erro +
 *   chip "Atrasada"; vencendo em ≤24h → cor de aviso + chip "Vence hoje" /
 *   "Vence em Xh"; sem prazo → sem destaque.
 * - TEMPO REAL: canal `notifications` do RealtimeGateway via RealtimeClient
 *   (@biblioteca-global/api-client, resolveRealtimeUrl + getAccessToken —
 *   padrão NotificacoesSino, com criação injetável em prop p/ teste): a cada
 *   `notification.created` (delegar/devolver ao usuário já publica nesse
 *   canal) refaz o GET — o socket é sinal, a API é fonte de verdade.
 *   Revalidação também em window focus e após concluir.
 * - QUIOSQUE/TABLET: layout limpo em tela cheia dentro da screen — cartões
 *   com alvos de toque ≥44px, tipografia legível, sem elementos de navegação
 *   próprios (o shell continua o da plataforma; a sessão longa já é do
 *   refresh token vigente).
 *
 * Convenções (espelham TarefaFluxoScreen / NotificacoesSino):
 * - UI não fala HTTP diretamente: tudo pelo `bundle.http` do useApi;
 * - `useRef` de montagem para não setState após desmontar;
 * - parsing tolerante (array cru ou { items }).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Grid,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import { RefreshRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveApiBaseUrl, resolveRealtimeUrl } from "../../../apps/web/src/api/client"
import { RealtimeClient } from "@biblioteca-global/api-client"
import type { CustomScreenProps } from "@biblioteca-global/ui"

export const componentId = "gestao-de-tarefas-global-dashboard"

const SLUG = "gestao-de-tarefas-global"

/** Janela do destaque "vence em breve" — próximas 24h (cálculo no front). */
const VENCE_EM_BREVE_MS = 24 * 60 * 60 * 1000

// ============================================================================
// Tipos das respostas da API (tolerantes)
// ============================================================================

/** Item do dashboard pessoal — espelha MinhaTarefaItem (subtarefa 1). */
type MinhaTarefaItem = {
  id: number
  titulo: string
  /** ISO-8601 ou null (sem prazo). */
  prazo: string | null
  prioridade: "baixa" | "media" | "alta" | "urgente"
  status: string
  areaId: number | null
  areaNome: string | null
}

/** Assinatura mínima do realtime injetável em teste (fake sem WebSocket). */
export interface DashboardRealtimeHandlers {
  /** `notification.created` → refazer o GET (sinal; a API é a fonte). */
  onNotificacaoCriada(): void
}

export interface DashboardRealtimeSubscription {
  close(): void
}

// ============================================================================
// Helpers de prazo
// ============================================================================

/**
 * Destaque visual derivado do prazo (cálculo no front):
 * - vencida (prazo < agora) → "atrasada" (cor de erro + chip "Atrasada");
 * - vencendo em ≤24h → "hoje"/"breve" (cor de aviso + chip "Vence hoje" ou
 *   "Vence em Xh", X = horas restantes arredondadas para cima);
 * - demais sem prazo → null (sem destaque).
 */
export function classificarPrazo(
  prazo: string | null | undefined,
  agora: number,
): { nivel: "atrasada" | "breve"; chip: string } | null {
  if (!prazo) return null
  const t = Date.parse(prazo)
  if (!Number.isFinite(t)) return null
  const diff = t - agora
  if (diff < 0) return { nivel: "atrasada", chip: "Atrasada" }
  if (diff <= VENCE_EM_BREVE_MS) {
    const horas = Math.max(1, Math.ceil(diff / 3_600_000))
    return { nivel: "breve", chip: horas < 24 ? "Vence hoje" : "Vence em breve" }
  }
  return null
}

const FORMATADOR_PRAZO = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
})

function formatarPrazo(iso: string | null | undefined): string {
  if (!iso) return "Sem prazo"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : FORMATADOR_PRAZO.format(d)
}

/** Aceita array cru ou `{ itens }` — a API da subtarefa 1 devolve { itens }. */
function comoLista(bruto: unknown): MinhaTarefaItem[] {
  if (Array.isArray(bruto)) return bruto as MinhaTarefaItem[]
  if (bruto && typeof bruto === "object") {
    const itens = (bruto as { itens?: MinhaTarefaItem[] }).itens
    if (Array.isArray(itens)) return itens
  }
  return []
}

function mensagemErro(erro: unknown): string {
  return erro instanceof Error && erro.message
    ? erro.message
    : "Não foi possível completar a operação."
}

// ============================================================================
// Tempo real (padrão NotificacoesSino — injetável em teste)
// ============================================================================

/** Realtime padrão: canal "notifications" (escopo = usuário da sessão). */
function criarRealtimePadrao(
  getAccessToken: () => string | null,
  handlers: DashboardRealtimeHandlers,
): DashboardRealtimeSubscription {
  const client = new RealtimeClient({
    url: resolveRealtimeUrl(),
    baseUrl: resolveApiBaseUrl(),
    getAccessToken,
    channel: "notifications",
    onMessage: (mensagem) => {
      // Delegar/devolver/concluir de outra pessoa publicam notification.created
      // nesse canal — qualquer um deles pode mudar "minhas tarefas".
      if (mensagem.type === "notification.created") handlers.onNotificacaoCriada()
    },
  })
  void client.connect()
  return { close: () => client.close() }
}

// ============================================================================
// Componente
// ============================================================================

export default function DashboardScreen(_props: CustomScreenProps): ReactNode {
  const bundle = useApi()

  const [tarefas, setTarefas] = useState<MinhaTarefaItem[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erroCarga, setErroCarga] = useState<string | null>(null)
  const [erroConclusao, setErroConclusao] = useState<string | null>(null)
  const [concluindoId, setConcluindoId] = useState<number | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** GET /:slug/tarefas/minhas — ordem do servidor (prazo/prioridade). */
  const carregar = useCallback(async () => {
    if (!bundle) return
    setCarregando(true)
    setErroCarga(null)
    try {
      const res = await bundle.http.request<MinhaTarefaItem[] | { itens: MinhaTarefaItem[] }>(
        "GET",
        `/${SLUG}/tarefas/minhas`,
        { auth: "access" },
      )
      if (!mounted.current) return
      setTarefas(comoLista(res))
    } catch (erro) {
      if (mounted.current) setErroCarga(mensagemErro(erro))
    } finally {
      if (mounted.current) setCarregando(false)
    }
  }, [bundle])

  useEffect(() => {
    void carregar()
  }, [carregar])

  // Canal realtime: push é SINAL — o GET é a fonte de verdade (padrão sino).
  const criarRealtime = useCallback(
    (handlers: DashboardRealtimeHandlers) =>
      bundle
        ? criarRealtimePadrao(bundle.getAccessToken, handlers)
        : { close: () => undefined },
    [bundle],
  )
  useEffect(() => {
    const sub = criarRealtime({
      onNotificacaoCriada: () => {
        if (mounted.current) void carregar()
      },
    })
    return () => sub.close()
  }, [criarRealtime, carregar])

  // Revalidação em window focus (tablet sempre aberto — pode sair da aba).
  useEffect(() => {
    const aoFocar = (): void => {
      if (mounted.current) void carregar()
    }
    window.addEventListener("focus", aoFocar)
    return () => window.removeEventListener("focus", aoFocar)
  }, [carregar])

  /** Concluir um item: POST .../concluir; no sucesso remove SEM reload. */
  const concluir = useCallback(
    async (tarefaId: number) => {
      if (!bundle || concluindoId !== null) return
      setConcluindoId(tarefaId)
      setErroConclusao(null)
      try {
        await bundle.http.request(
          "POST",
          `/${SLUG}/tarefas/${tarefaId}/concluir`,
          { auth: "access" },
        )
        if (!mounted.current) return
        // Remoção local imediata — o item concluído sai da lista sem reload.
        setTarefas((prev) => prev.filter((t) => t.id !== tarefaId))
        // E revalidação: alinha com o servidor (ex.: delegação concorrente).
        void carregar()
      } catch (erro) {
        // 403/409 da máquina de estados: mensagem LITERAL da API.
        if (mounted.current) setErroConclusao(mensagemErro(erro))
      } finally {
        if (mounted.current) setConcluindoId(null)
      }
    },
    [bundle, concluindoId, carregar],
  )

  // ============================================================================
  // Render
  // ============================================================================

  if (carregando && tarefas.length === 0) {
    return (
      <Box
        sx={{ display: "flex", flexDirection: "column", alignItems: "center", py: 8, gap: 2 }}
        data-testid="dashboard-loading"
      >
        <CircularProgress size={36} />
        <Typography color="text.secondary">Carregando suas tarefas...</Typography>
      </Box>
    )
  }

  return (
    <Stack spacing={2}>
      {/* Cabeçalho simples — quiosque: o essencial, sem menus próprios. */}
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Minhas tarefas
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {tarefas.length} pendente{tarefas.length === 1 ? "" : "s"}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshRounded />}
          onClick={() => void carregar()}
          disabled={carregando}
          sx={{ minHeight: 44 }}
          data-testid="dashboard-atualizar"
        >
          Atualizar
        </Button>
      </Stack>

      {erroCarga && <Alert severity="error">{erroCarga}</Alert>}
      {erroConclusao && (
        <Alert severity="error" data-testid="dashboard-erro-conclusao">
          {erroConclusao}
        </Alert>
      )}

      {!carregando && tarefas.length === 0 && (
        <Alert severity="success" data-testid="dashboard-vazio">
          Nenhuma tarefa pendente — tudo em dia.
        </Alert>
      )}

      {/* Lista em cartões — grid responsivo: 1 coluna em telas pequenas,
          2 colunas a partir de ~900px (tablet paisagem). Alvos de toque
          ≥44px (Botões min-height 44). */}
      <Grid container spacing={2}>
        {tarefas.map((tarefa) => {
          const destaque = classificarPrazo(tarefa.prazo, Date.now())
          const concluindo = concluindoId === tarefa.id
          return (
            <Grid key={tarefa.id} size={{ xs: 12, md: 6 }}>
              <Paper
                variant="outlined"
                sx={{
                  p: 2,
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  borderLeftWidth: 6,
                  borderLeftStyle: "solid",
                  borderColor:
                    destaque?.nivel === "atrasada"
                      ? "error.main"
                      : destaque?.nivel === "breve"
                        ? "warning.main"
                        : undefined,
                  bgcolor:
                    destaque?.nivel === "atrasada"
                      ? "error.50"
                      : destaque?.nivel === "breve"
                        ? "warning.50"
                        : undefined,
                }}
                data-testid={`tarefa-card-${tarefa.id}`}
              >
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography
                    variant="h6"
                    sx={{ flexGrow: 1, minWidth: "60%" }}
                    data-testid={`tarefa-titulo-${tarefa.id}`}
                  >
                    {tarefa.titulo}
                  </Typography>
                  {destaque && (
                    <Chip
                      label={destaque.chip}
                      color={destaque.nivel === "atrasada" ? "error" : "warning"}
                      size="small"
                      variant="filled"
                      data-testid={`tarefa-chip-${tarefa.id}`}
                    />
                  )}
                </Stack>

                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {tarefa.areaNome && (
                    <Chip
                      label={tarefa.areaNome}
                      size="small"
                      variant="outlined"
                      data-testid={`tarefa-area-${tarefa.id}`}
                    />
                  )}
                  <Chip
                    label={`Prioridade: ${tarefa.prioridade}`}
                    size="small"
                    variant="outlined"
                  />
                  <Typography
                    variant="body2"
                    color={destaque?.nivel === "atrasada" ? "error" : "text.secondary"}
                    sx={{ fontWeight: destaque ? 700 : 400 }}
                    data-testid={`tarefa-prazo-${tarefa.id}`}
                  >
                    Prazo: {formatarPrazo(tarefa.prazo)}
                  </Typography>
                </Stack>

                <Box sx={{ flexGrow: 1 }} />

                <Button
                  variant="contained"
                  color="success"
                  size="large"
                  fullWidth
                  disabled={concluindo}
                  startIcon={
                    concluindo ? <CircularProgress size={18} color="inherit" /> : undefined
                  }
                  onClick={() => void concluir(tarefa.id)}
                  sx={{ minHeight: 48, fontSize: "1.05rem" }}
                  data-testid={`tarefa-concluir-${tarefa.id}`}
                >
                  {concluindo ? "Concluindo..." : "Concluir"}
                </Button>
              </Paper>
            </Grid>
          )
        })}
      </Grid>
    </Stack>
  )
}
