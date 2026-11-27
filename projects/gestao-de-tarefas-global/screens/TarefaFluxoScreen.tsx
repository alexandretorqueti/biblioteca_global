/**
 * TarefaFluxoScreen — tela custom de detalhe/fluxo de uma tarefa
 * (gestao-de-tarefas-global — macro #3, subtarefa 1589).
 *
 * Aberta pela `childRoutes` da grid de tarefas (`componentId:
 * "gestao-de-tarefas-global-tarefa-fluxo"`, pai = linha da tarefa). Entrega:
 * - DELEGAR: dialog com colaboradores ATIVOS da organização da tarefa
 *   (POST `.../delegar` body { responsavelId });
 * - DEVOLVER: dialog com os 3 sabores (concluida / precisa_informacoes /
 *   aguardando_terceiro) + mensagem obrigatória não vazia
 *   (POST `.../devolver` body { sabor, mensagem });
 * - HISTÓRICO: trilha cronológica SOMENTE LEITURA (GET `.../historico`),
 *   com tipo de evento, envolvidos (nome), mensagem e data;
 * - CHAT: mensagens da tarefa com autor e data (GET `.../mensagens`),
 *   composer com validação de texto não vazio no FRONT (POST `.../mensagens`
 *   body { texto }) e recarga do chat após transições de estado;
 * - ANEXOS (macro #6): lista (GET `.../anexos` via bundle.http), upload
 *   (input[type=file] oculto + FormData + fetch autenticado com o access
 *   token do bundle — o ApiHttpClient não suporta multipart/resposta
 *   binária), preview de imagem/PDF via blob + URL.createObjectURL
 *   (GET `.../anexos/:anexoId/preview`) e download via anchor com blob
 *   (GET `.../.../download`). A UI usa apenas ids/URLs da API — nenhum
 *   caminho físico do servidor.
 *
 * Regras de estado (máquina de estados) são do BACKEND — a tela só reflete:
 * estados terminais desabilitam as ações de fluxo; erros 403/409 da API são
 * exibidos literalmente (mensagem amigável do domínio). Não há escrita de
 * status via CRUD (regra da config: transições só pelo fluxo custom).
 *
 * Convenções (espelham projects/gerenteagentes/screens/PlanoProjetoScreen):
 * - UI não fala HTTP diretamente: tudo pelo `bundle.http` do useApi;
 * - `useRef` de montagem para não setState após desmontar;
 * - parsing tolerante de lista (array cru ou { items }).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import {
  DownloadRounded,
  RefreshRounded,
  SendRounded,
  UploadFileRounded,
  VisibilityRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { resolveApiBaseUrl } from "../../../apps/web/src/api/client"
import type { CustomScreenProps } from "@biblioteca-global/ui"

export const componentId = "gestao-de-tarefas-global-tarefa-fluxo"

// ============================================================================
// Constantes de domínio (espelham shared/enum da tabela `tarefas`)
// ============================================================================

const SLUG = "gestao-de-tarefas-global"

type CorChip = "default" | "primary" | "info" | "warning" | "success" | "error"

/** Estados do ciclo de vida — espelha STATUS_TAREFA (schema.ts). */
const STATUS_INFO: Record<string, { label: string; cor: CorChip }> = {
  aberta: { label: "Aberta", cor: "default" },
  delegada: { label: "Delegada", cor: "info" },
  concluida: { label: "Concluída", cor: "success" },
  precisa_informacoes: { label: "Precisa de informações", cor: "warning" },
  aguardando_terceiro: { label: "Aguardando terceiro", cor: "warning" },
  cancelada: { label: "Cancelada", cor: "error" },
}

/** Estados terminais — sem transição de saída (sem delegar/devolver). */
const STATUS_TERMINAIS = new Set(["concluida", "cancelada"])

/** Sabores da devolução — mesmo enum do DTO (fluxo-tarefas.schemas.ts). */
const SABORES_DEVOLUCAO = [
  { valor: "concluida", label: "Concluída — trabalho finalizado" },
  { valor: "precisa_informacoes", label: "Precisa de mais informações" },
  { valor: "aguardando_terceiro", label: "Aguardando outra pessoa" },
] as const
type SaborDevolucao = (typeof SABORES_DEVOLUCAO)[number]["valor"]

/** Rótulos/cor dos tipos de evento do histórico (enum da tabela). */
const EVENTO_INFO: Record<string, { label: string; cor: CorChip }> = {
  criacao: { label: "Criação", cor: "default" },
  delegacao: { label: "Delegação", cor: "info" },
  reatribuicao: { label: "Reatribuição", cor: "info" },
  devolucao_concluida: { label: "Devolução — concluída", cor: "success" },
  devolucao_precisa_info: { label: "Devolução — mais informações", cor: "warning" },
  devolucao_aguardando_terceiro: { label: "Devolução — aguardando terceiro", cor: "warning" },
  mudanca_status: { label: "Mudança de status", cor: "default" },
  mudanca_prazo: { label: "Alteração de prazo", cor: "default" },
  anexo: { label: "Anexo", cor: "default" },
}

// ============================================================================
// Tipos das respostas da API (tolerantes)
// ============================================================================

type TarefaResumo = {
  id?: number
  titulo?: string
  status?: string
  responsavelId?: number | null
  organizacaoId?: number | null
  prazo?: string | null
}

type ItemHistorico = {
  id: number
  tipoEvento: string
  deColaboradorNome?: string | null
  paraColaboradorNome?: string | null
  mensagem?: string | null
  criadoEm: string
}

type MensagemItem = {
  id: number
  autorId?: number
  autorNome?: string
  texto: string
  criadoEm: string
}

type ColaboradorOpcao = { id: number; nome: string }

/** Item de anexo — espelha ItemAnexo do backend (sem caminho físico). */
type AnexoItem = {
  id: number
  nomeArquivo: string
  mimeType: string | null
  tamanhoBytes: number | null
  enviadoPorNome: string
  criadoEm: string
}

/** MIMEs renderizáveis inline no navegador (preview via nova aba). */
const MIMES_PREVIEWAVEIS = new Set(["image/png", "image/jpeg", "application/pdf"])

/** Limite de upload validado no FRONT (~10MB) — o backend revalida. */
const LIMITE_UPLOAD_BYTES = 10 * 1024 * 1024

/** Extensões aceitas (espelha a whitelist do backend) p/ o `accept`. */
const EXTENSOES_ACEITAS = [".pdf", ".png", ".jpg", ".jpeg",
  ".txt", ".js", ".mjs", ".cjs", ".md", ".markdown", ".csv", ".tsv",
  ".json", ".log", ".html", ".htm", ".xml", ".yml", ".yaml", ".ini",
  ".cfg", ".conf", ".sh", ".sql", ".toml", ".properties"].join(",")

// ============================================================================
// Helpers
// ============================================================================

const FORMATADOR_DATA = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
})

function formatarData(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : FORMATADOR_DATA.format(d)
}

/** Aceita array cru ou paginado `{ items }` — respostas custom vs CRUD. */
function comoLista<T>(bruto: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(bruto)) return bruto
  return bruto?.items ?? []
}

function mensagemErro(erro: unknown): string {
  return erro instanceof Error && erro.message
    ? erro.message
    : "Não foi possível completar a operação."
}

/** Tamanho legível (B/KB/MB). */
function formatarTamanho(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1).replace(/\.0$/, "")} MB`
}

/** Extrai a mensagem literal do corpo do erro da API (NestJS). */
async function mensagemDoCorpoErro(resposta: Response): Promise<string> {
  try {
    const texto = await resposta.text()
    if (texto) {
      const corpo = JSON.parse(texto) as { message?: string | string[] }
      if (typeof corpo.message === "string") return corpo.message
      if (Array.isArray(corpo.message) && corpo.message.length > 0) {
        return corpo.message.join("; ")
      }
    }
  } catch {
    // corpo não-JSON — cai no fallback abaixo
  }
  return `Falha na operação (HTTP ${resposta.status}).`
}

/**
 * Fetch autenticado (Bearer do bundle) para rotas multipart/binárias — o
 * ApiHttpClient não suporta multipart nem resposta binária (pacotes
 * verificadas em apps/web/src/api/client.ts e packages/api-client/src/http.ts).
 * O token é o MESMO access token usado pelo bundle.http.
 */
async function fetchAutenticado(
  bundle: NonNullable<ReturnType<typeof useApi>>,
  caminho: string,
  opcoes: RequestInit = {},
): Promise<Response> {
  const token = bundle.getAccessToken()
  return fetch(`${resolveApiBaseUrl()}${caminho}`, {
    ...opcoes,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opcoes.headers,
    },
  })
}

// ============================================================================
// Componente
// ============================================================================

export default function TarefaFluxoScreen(props: CustomScreenProps): ReactNode {
  const bundle = useApi()

  const idBruto = props.parentRow?.id ?? props.filterValue
  const tarefaId = typeof idBruto === "number" ? idBruto : Number(idBruto)
  const tarefaValida = Number.isFinite(tarefaId) && tarefaId > 0
  const base = tarefaValida ? `/${SLUG}/tarefas/${tarefaId}` : null

  const [tarefa, setTarefa] = useState<TarefaResumo | null>(null)
  const [historico, setHistorico] = useState<ItemHistorico[]>([])
  const [mensagens, setMensagens] = useState<MensagemItem[]>([])
  const [anexos, setAnexos] = useState<AnexoItem[]>([])
  const [colaboradores, setColaboradores] = useState<ColaboradorOpcao[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erroCarga, setErroCarga] = useState<string | null>(null)

  // Diálogo de transição (delegar/devolver) — feedback do backend exibido ao lado.
  const [dialog, setDialog] = useState<"delegar" | "devolver" | null>(null)
  const [dialogErro, setDialogErro] = useState<string | null>(null)
  const [delegarPara, setDelegarPara] = useState<number | null>(null)
  const [devolverSabor, setDevolverSabor] = useState<SaborDevolucao>("precisa_informacoes")
  const [devolverMensagem, setDevolverMensagem] = useState("")
  const [enviando, setEnviando] = useState<string | null>(null)

  const [avisoAcao, setAvisoAcao] = useState<string | null>(null)
  const [erroAcao, setErroAcao] = useState<string | null>(null)

  // Chat.
  const [chatTexto, setChatTexto] = useState("")
  const [chatEnviando, setChatEnviando] = useState(false)
  const [chatErro, setChatErro] = useState<string | null>(null)

  // Anexos — upload via input oculto; erros da API exibidos literalmente.
  const [uploadEnviando, setUploadEnviando] = useState(false)
  const [anexosErro, setAnexosErro] = useState<string | null>(null)
  const inputArquivoRef = useRef<HTMLInputElement | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const carregar = useCallback(async () => {
    if (!bundle || !base) return
    setCarregando(true)
    setErroCarga(null)
    try {
      const [resTarefa, resHistorico, resMensagens, resAnexos] = await Promise.all([
        bundle.http.request<TarefaResumo>("GET", base, { auth: "access" }),
        bundle.http
          .request<ItemHistorico[]>("GET", `${base}/historico`, { auth: "access" })
          .catch(() => [] as ItemHistorico[]),
        bundle.http
          .request<MensagemItem[]>("GET", `${base}/mensagens`, { auth: "access" })
          .catch(() => [] as MensagemItem[]),
        bundle.http
          .request<AnexoItem[]>("GET", `${base}/anexos`, { auth: "access" })
          .catch(() => [] as AnexoItem[]),
      ])
      if (!mounted.current) return
      setTarefa(resTarefa ?? null)
      // Cronológico (asc) — a API já devolve ordenado; ordenação defensiva.
      setHistorico(
        comoLista(resHistorico).slice().sort((a, b) => a.criadoEm.localeCompare(b.criadoEm)),
      )
      setMensagens(
        comoLista(resMensagens).slice().sort((a, b) => a.criadoEm.localeCompare(b.criadoEm)),
      )
      setAnexos(
        comoLista(resAnexos).slice().sort((a, b) => a.criadoEm.localeCompare(b.criadoEm)),
      )
    } catch (erro) {
      if (mounted.current) setErroCarga(mensagemErro(erro))
    } finally {
      if (mounted.current) setCarregando(false)
    }
  }, [bundle, base])

  useEffect(() => {
    void carregar()
  }, [carregar])

  // Colaboradores ativos da organização da tarefa — cache por organização;
  // usados apenas no dialog de delegação (a máquina revalida no backend).
  const organizacaoId = tarefa?.organizacaoId ?? null
  const colaboradoresParaOrganizacao = useRef<number | null>(null)
  useEffect(() => {
    if (!bundle || organizacaoId == null) return
    if (colaboradoresParaOrganizacao.current === organizacaoId) return
    colaboradoresParaOrganizacao.current = organizacaoId
    void bundle.http
      .request<ColaboradorOpcao[] | { items?: ColaboradorOpcao[] }>(
        "GET",
        `/${SLUG}/colaboradores`,
        {
          auth: "access",
          query: { organizacaoId, ativo: "true", pageSize: 200 },
        },
      )
      .then((res) => {
        if (mounted.current) setColaboradores(comoLista(res))
      })
      .catch(() => {
        colaboradoresParaOrganizacao.current = null
      })
  }, [bundle, organizacaoId])

  const status = tarefa?.status ?? ""
  const terminal = STATUS_TERMINAIS.has(status)
  const statusInfo = STATUS_INFO[status] ?? { label: status || "—", cor: "default" as CorChip }

  /** Executa uma transição do fluxo e RECARREGA tudo (histórico + chat). */
  const executarTransicao = async (
    caminho: "delegar" | "devolver",
    body: Record<string, unknown>,
    rotuloSucesso: string,
  ): Promise<boolean> => {
    if (!bundle || !base) return false
    setEnviando(caminho)
    setDialogErro(null)
    try {
      await bundle.http.request("POST", `${base}/${caminho}`, { auth: "access", body })
      if (!mounted.current) return true
      setDialog(null)
      setDelegarPara(null)
      setDevolverMensagem("")
      setAvisoAcao(rotuloSucesso)
      setErroAcao(null)
      await carregar() // transição muda status/responsável E o chat/histórico devem refletir
      return true
    } catch (erro) {
      if (mounted.current) setDialogErro(mensagemErro(erro)) // 403/409 da máquina, literal
      return false
    } finally {
      if (mounted.current) setEnviando(null)
    }
  }

  const enviarMensagem = async (): Promise<void> => {
    const texto = chatTexto.trim()
    if (!bundle || !base || !texto || chatEnviando) return
    setChatEnviando(true)
    setChatErro(null)
    try {
      const criada = await bundle.http.request<MensagemItem>(
        "POST",
        `${base}/mensagens`,
        { auth: "access", body: { texto } },
      )
      if (!mounted.current) return
      if (criada && typeof criada.id === "number") {
        setMensagens((prev) => [...prev, criada])
      } else {
        await carregar()
      }
      setChatTexto("")
    } catch (erro) {
      if (mounted.current) setChatErro(mensagemErro(erro))
    } finally {
      if (mounted.current) setChatEnviando(false)
    }
  }

  /** Upload multipart (campo 'arquivo') — depois recarrega lista + histórico. */
  const enviarAnexo = async (arquivo: File): Promise<void> => {
    if (!bundle || !base) return
    if (arquivo.size > LIMITE_UPLOAD_BYTES) {
      setAnexosErro(
        `Arquivo excede o limite de ~10MB (${formatarTamanho(arquivo.size)}) — escolha um arquivo menor.`,
      )
      return
    }
    setUploadEnviando(true)
    setAnexosErro(null)
    try {
      const form = new FormData()
      form.append("arquivo", arquivo)
      const resposta = await fetchAutenticado(bundle, `${base}/anexos`, {
        method: "POST",
        body: form,
      })
      if (!resposta.ok) throw new Error(await mensagemDoCorpoErro(resposta))
      if (!mounted.current) return
      // Recarrega tudo: a lista de anexos E o histórico (evento 'anexo').
      await carregar()
    } catch (erro) {
      if (mounted.current) setAnexosErro(mensagemErro(erro))
    } finally {
      if (mounted.current) setUploadEnviando(false)
    }
  }

  const aoSelecionarArquivo = (evento: ChangeEvent<HTMLInputElement>): void => {
    const arquivo = evento.target.files?.[0]
    evento.target.value = "" // permite reescolher o mesmo arquivo
    if (arquivo) void enviarAnexo(arquivo)
  }

  /** Preview inline (imagem/PDF) via blob + URL.createObjectURL. */
  const abrirPreview = async (anexo: AnexoItem): Promise<void> => {
    if (!bundle) return
    setAnexosErro(null)
    try {
      const resposta = await fetchAutenticado(bundle, `${base}/anexos/${anexo.id}/preview`)
      if (!resposta.ok) throw new Error(await mensagemDoCorpoErro(resposta))
      const blob = await resposta.blob()
      window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer")
    } catch (erro) {
      if (mounted.current) setAnexosErro(mensagemErro(erro))
    }
  }

  /** Download via anchor com blob (demais tipos + "baixar" de previewáveis). */
  const baixarAnexo = async (anexo: AnexoItem): Promise<void> => {
    if (!bundle) return
    setAnexosErro(null)
    try {
      const resposta = await fetchAutenticado(bundle, `${base}/anexos/${anexo.id}/download`)
      if (!resposta.ok) throw new Error(await mensagemDoCorpoErro(resposta))
      const blob = await resposta.blob()
      const url = URL.createObjectURL(blob)
      const ancora = document.createElement("a")
      ancora.href = url
      ancora.download = anexo.nomeArquivo
      ancora.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (erro) {
      if (mounted.current) setAnexosErro(mensagemErro(erro))
    }
  }

  const abrirDialog = (tipo: "delegar" | "devolver"): void => {
    setDialogErro(null)
    setAvisoAcao(null)
    setDialog(tipo)
  }

  // ============================================================================
  // Render
  // ============================================================================

  if (!tarefaValida) {
    return <Alert severity="error">Tarefa inválida: abre esta tela pela grid de tarefas.</Alert>
  }

  return (
    <Stack spacing={2}>
      {/* Cabeçalho: identificação + estado atual da tarefa */}
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
            <Typography
              variant="h6"
              sx={{ flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" }}
            >
              {tarefa?.titulo ?? `Tarefa #${tarefaId}`}
            </Typography>
            <Chip label={statusInfo.label} color={statusInfo.cor} size="small" />
            <Button
              size="small"
              startIcon={<RefreshRounded />}
              onClick={() => void carregar()}
              disabled={carregando}
            >
              Atualizar
            </Button>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Responsável atual:{" "}
            {tarefa?.responsavelId != null && tarefa.responsavelId > 0
              ? (colaboradores.find((c) => c.id === tarefa.responsavelId)?.nome ??
                `Colaborador #${tarefa.responsavelId}`)
              : "—"}
            {" · "}
            Prazo: {formatarData(tarefa?.prazo)}
          </Typography>
          {terminal && (
            <Alert severity="info" sx={{ py: 0.5 }}>
              Tarefa em estado terminal — o fluxo não aceita mais transições
              (histórico e chat permanecem disponíveis).
            </Alert>
          )}
          {avisoAcao && <Alert severity="success">{avisoAcao}</Alert>}
          {erroAcao && <Alert severity="error">{erroAcao}</Alert>}
          {erroCarga && <Alert severity="error">{erroCarga}</Alert>}

          {/* Ações de fluxo — validação de estado é do backend; aqui só
              refletemos os terminais. */}
          <Stack direction="row" spacing={1} sx={{ pt: 0.5 }} flexWrap="wrap" useFlexGap>
            <Button
              variant="contained"
              color="primary"
              disabled={terminal || enviando !== null}
              onClick={() => abrirDialog("delegar")}
            >
              Delegar
            </Button>
            <Button
              variant="outlined"
              color="secondary"
              disabled={terminal || enviando !== null}
              onClick={() => abrirDialog("devolver")}
            >
              Devolver
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Grid container spacing={2}>
        {/* Histórico — trilha cronológica somente leitura */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2, height: "100%" }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              Histórico do fluxo
            </Typography>
            {carregando && historico.length === 0 ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                <CircularProgress size={22} />
              </Box>
            ) : historico.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nenhum evento registrado ainda.
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {historico.map((item, idx) => {
                  const info = EVENTO_INFO[item.tipoEvento] ?? {
                    label: item.tipoEvento,
                    cor: "default" as CorChip,
                  }
                  const envolvidos = [
                    item.deColaboradorNome ? `De: ${item.deColaboradorNome}` : null,
                    item.paraColaboradorNome ? `Para: ${item.paraColaboradorNome}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                  return (
                    <Box key={item.id}>
                      {idx > 0 && <Divider sx={{ mb: 1.5 }} />}
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                        <Chip size="small" label={info.label} color={info.cor} />
                        <Typography variant="caption" color="text.secondary">
                          {formatarData(item.criadoEm)}
                        </Typography>
                      </Stack>
                      {envolvidos && (
                        <Typography variant="body2">{envolvidos}</Typography>
                      )}
                      {item.mensagem && (
                        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>
                          {item.mensagem}
                        </Typography>
                      )}
                    </Box>
                  )
                })}
              </Stack>
            )}
          </Paper>
        </Grid>

        {/* Chat da tarefa */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column" }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              Chat da tarefa
            </Typography>
            <Box sx={{ flexGrow: 1, minHeight: 180, maxHeight: 420, overflowY: "auto" }}>
              {carregando && mensagens.length === 0 ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                  <CircularProgress size={22} />
                </Box>
              ) : mensagens.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Nenhuma mensagem ainda — converse sobre a tarefa abaixo.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {mensagens.map((m) => (
                    <Paper
                      key={m.id}
                      variant="outlined"
                      sx={{ p: 1, bgcolor: "action.hover" }}
                    >
                      <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2">{m.autorNome ?? "Colaborador"}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatarData(m.criadoEm)}
                        </Typography>
                      </Stack>
                      <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                        {m.texto}
                      </Typography>
                    </Paper>
                  ))}
                </Stack>
              )}
            </Box>
            {chatErro && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {chatErro}
              </Alert>
            )}
            <Divider sx={{ my: 1 }} />
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <TextField
                label="Mensagem"
                placeholder="Escreva para a equipe desta tarefa"
                value={chatTexto}
                onChange={(e) => setChatTexto(e.target.value)}
                size="small"
                multiline
                minRows={2}
                fullWidth
                disabled={chatEnviando}
                sx={{ minWidth: 0 }}
              />
              <Button
                variant="contained"
                sx={{ flexShrink: 0 }}
                disabled={chatTexto.trim().length === 0 || chatEnviando}
                onClick={() => void enviarMensagem()}
                startIcon={chatEnviando ? <CircularProgress size={16} color="inherit" /> : <SendRounded />}
              >
                Enviar
              </Button>
            </Stack>
            {chatTexto.trim().length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                A mensagem não pode ser vazia.
              </Typography>
            )}
          </Paper>
        </Grid>

        {/* Anexos — upload + lista com preview/download (macro #6) */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column" }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
                Anexos
              </Typography>
              <input
                ref={inputArquivoRef}
                type="file"
                accept={EXTENSOES_ACEITAS}
                hidden
                onChange={(e) => aoSelecionarArquivo(e)}
              />
              <Button
                variant="contained"
                size="small"
                startIcon={uploadEnviando ? <CircularProgress size={14} color="inherit" /> : <UploadFileRounded />}
                disabled={uploadEnviando}
                onClick={() => inputArquivoRef.current?.click()}
              >
                {uploadEnviando ? "Enviando..." : "Anexar arquivo"}
              </Button>
            </Stack>
            <Box sx={{ flexGrow: 1, minHeight: 120, maxHeight: 420, overflowY: "auto" }}>
              {carregando && anexos.length === 0 ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
                  <CircularProgress size={22} />
                </Box>
              ) : anexos.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Nenhum anexo nesta tarefa — use "Anexar arquivo" (PDF, imagem ou texto, até ~10MB).
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {anexos.map((a) => (
                    <Paper key={a.id} variant="outlined" sx={{ p: 1 }}>
                      <Typography variant="subtitle2" noWrap title={a.nomeArquivo}>
                        {a.nomeArquivo}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {a.mimeType ?? "tipo desconhecido"} · {formatarTamanho(a.tamanhoBytes)}
                        {" · "}
                        {a.enviadoPorNome} · {formatarData(a.criadoEm)}
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                        {MIMES_PREVIEWAVEIS.has((a.mimeType ?? "").toLowerCase()) && (
                          <Button
                            size="small"
                            startIcon={<VisibilityRounded fontSize="small" />}
                            onClick={() => void abrirPreview(a)}
                          >
                            Visualizar
                          </Button>
                        )}
                        <Button
                          size="small"
                          startIcon={<DownloadRounded fontSize="small" />}
                          onClick={() => void baixarAnexo(a)}
                        >
                          Baixar
                        </Button>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              )}
            </Box>
            {anexosErro && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {anexosErro}
              </Alert>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Dialog DELEGAR — colaboradores ativos da organização */}
      <Dialog
        open={dialog === "delegar"}
        fullWidth
        maxWidth="sm"
        onClose={() => {
          if (enviando !== null) return
          setDialog(null)
        }}
      >
        <DialogTitle>Delegar tarefa</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ minWidth: { xs: 0, sm: 320 }, pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Escolha o novo responsável (colaborador ativo da organização). A
              delegação fica registrada no histórico.
            </Typography>
            <FormControl size="small" fullWidth>
              <InputLabel id="delegar-responsavel-label">Responsável</InputLabel>
              <Select
                labelId="delegar-responsavel-label"
                label="Responsável"
                value={delegarPara === null ? "" : String(delegarPara)}
                onChange={(e) =>
                  setDelegarPara(e.target.value === "" ? null : Number(e.target.value))
                }
              >
                {colaboradores.length === 0 && (
                  <MenuItem value="" disabled>
                    Nenhum colaborador ativo carregado
                  </MenuItem>
                )}
                {colaboradores.map((c) => (
                  <MenuItem key={c.id} value={String(c.id)}>
                    {c.nome}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {dialogErro && <Alert severity="error">{dialogErro}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={enviando !== null} onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button
            variant="contained"
            disabled={delegarPara == null || enviando !== null}
            onClick={() =>
              void executarTransicao(
                "delegar",
                { responsavelId: delegarPara },
                "Tarefa delegada — status e responsável atualizados.",
              )
            }
          >
            {enviando === "delegar" ? "Delegando..." : "Delegar"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Dialog DEVOLVER — 3 sabores + mensagem obrigatória */}
      <Dialog
        open={dialog === "devolver"}
        fullWidth
        maxWidth="sm"
        onClose={() => {
          if (enviando !== null) return
          setDialog(null)
        }}
      >
        <DialogTitle>Devolver tarefa</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ minWidth: { xs: 0, sm: 340 }, pt: 1 }}>
            <FormControl component="fieldset">
              <RadioGroup
                value={devolverSabor}
                onChange={(e) => setDevolverSabor(e.target.value as SaborDevolucao)}
              >
                {SABORES_DEVOLUCAO.map((s) => (
                  <FormControlLabel
                    key={s.valor}
                    value={s.valor}
                    control={<Radio size="small" />}
                    label={s.label}
                  />
                ))}
              </RadioGroup>
            </FormControl>
            <TextField
              label="Mensagem da devolução"
              placeholder="Explique o motivo — obrigatório e não vazio"
              value={devolverMensagem}
              onChange={(e) => setDevolverMensagem(e.target.value)}
              size="small"
              multiline
              minRows={3}
              error={devolverMensagem.trim().length === 0}
              helperText={
                devolverMensagem.trim().length === 0
                  ? "Toda devolução exige mensagem — ela entra no histórico."
                  : " "
              }
            />
            {dialogErro && <Alert severity="error">{dialogErro}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={enviando !== null} onClick={() => setDialog(null)}>
            Cancelar
          </Button>
          <Button
            variant="contained"
            disabled={devolverMensagem.trim().length === 0 || enviando !== null}
            onClick={() =>
              void executarTransicao(
                "devolver",
                { sabor: devolverSabor, mensagem: devolverMensagem.trim() },
                "Devolução registrada — novo status aplicado.",
              )
            }
          >
            {enviando === "devolver" ? "Devolvendo..." : "Devolver"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
