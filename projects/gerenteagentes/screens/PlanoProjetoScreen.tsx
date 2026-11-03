/**
 * PlanoProjetoScreen — painel "Plano do projeto" (Geração Macro F2).
 *
 * Dá ergonomia de aprovação humana ao plano gerado pela F1
 * (docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md §2/§3.4/§5):
 *
 * - Estado da geração mais recente com Chip por status
 *   (pending/running/awaiting_clarification/awaiting_approval/approved/
 *   completed/rejected/failed);
 * - Renderização TOLERANTE do plano (contrato §5) a partir de
 *   `geracoes_projeto.tasks`: classificação do sistema, requisitos REQ-*,
 *   tarefas (objetivo/escopo/aceite/executor/dependências/risco),
 *   especificacaoCrud, matrizCobertura, lacunas, lacunasBiblioteca, riscos,
 *   foraDeFase e materialização (pós-approve). Dados ausentes/parciais →
 *   seções omitidas ou placeholder, sem crash; tasks null/não-plano →
 *   estado "sem plano";
 * - 4 decisões em `awaiting_approval` contra
 *   POST /gerenteagentes/projetos-captados/:id/geracoes/:geracaoId/aprovar:
 *   Aprovar (decisao=approve), Editar (edição inline de título/escopo/aceite/
 *   dependências + reordenação → decisao=approve com planoEditado integral;
 *   422 "Plano macro inválido: ..." da API é exibido em Alert), Pedir revisão
 *   (comentário obrigatório → decisao=revise) e Rejeitar (comentário opcional
 *   → decisao=reject);
 * - Chat de clarificação integrado: GET/POST
 *   /gerenteagentes/projetos-captados/:id/chat (a transição
 *   awaiting_clarification→pending já é feita pelo backend no POST role=user).
 *
 * A UI não fala HTTP diretamente — tudo passa pelo bundle do useApi
 * (regra do projeto, mesmo padrão da ModelSelectionScreen).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material"
import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  CheckRounded,
  CloseRounded,
  EditRounded,
  RateReviewRounded,
  SendRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import type { CustomScreenProps } from "@biblioteca-global/ui"

export const componentId = "gerenteagentes-plano-projeto"

// ============================================================================
// Tipos tolerantes (o JSON do plano é dinâmico; contrato §5 em
// projects/gerenteagentes/api/macro-plan.ts)
// ============================================================================

type CorChip = "default" | "primary" | "info" | "warning" | "success" | "error"

type Geracao = {
  id?: number
  projetoId?: number
  status?: string
  tasks?: unknown
  erro?: string | null
  feedback?: string | null
  modelo?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

type MensagemChat = {
  id?: number
  role?: string
  texto?: string
  createdAt?: string | null
}

/** Item de tarefa em modo edição (posição no array = ordem; seq derivado). */
type TarefaEdit = {
  key: number
  seq: number
  titulo: string
  objetivo: string
  escopo: string
  /** Aceite em texto multilinha (um item por linha). */
  aceiteTexto: string
  /** depende_de em texto (seqs separados por vírgula). */
  dependeTexto: string
  executor: string
  risco: string
  auto_start: boolean
  requisitos: string[]
}

const STATUS_INFO: Record<string, { label: string; cor: CorChip }> = {
  pending: { label: "Pendente", cor: "default" },
  running: { label: "Em geração", cor: "info" },
  awaiting_clarification: { label: "Aguardando clarificação", cor: "warning" },
  awaiting_approval: { label: "Aguardando aprovação", cor: "warning" },
  approved: { label: "Aprovado", cor: "success" },
  completed: { label: "Concluído", cor: "success" },
  rejected: { label: "Rejeitado", cor: "error" },
  failed: { label: "Falhou", cor: "error" },
}

const COR_CLASSIFICACAO_REQ: Record<string, CorChip> = {
  crud: "success",
  custom: "info",
  lacuna: "warning",
}

const COR_RISCO: Record<string, CorChip> = {
  baixo: "success",
  medio: "warning",
  alto: "error",
}

const COR_ROLE_CHAT: Record<string, CorChip> = {
  user: "primary",
  assistant: "info",
  analyst: "info",
  system: "default",
}

// ============================================================================
// Helpers tolerantes
// ============================================================================

function comoArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function comoRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function texto(v: unknown): string {
  if (typeof v === "string") return v
  if (v == null) return ""
  return String(v)
}

function listaTextos(v: unknown): string[] {
  return comoArray(v).map(texto).filter((s) => s.trim() !== "")
}

function listaNumeros(v: unknown): number[] {
  return comoArray(v)
    .map((item) => Number(item))
    .filter((n) => Number.isInteger(n))
}

function formatarData(v: unknown): string {
  const s = texto(v)
  if (!s) return ""
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString("pt-BR")
}

/** Extrai o plano (kind="plano") do json tasks, ou null quando não há plano. */
function extrairPlano(tasks: unknown): Record<string, unknown> | null {
  const rec = comoRecord(tasks)
  if (rec && rec.kind === "plano") return rec
  return null
}

function parseDependeTexto(valor: string): number[] {
  return valor
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1)
}

function parseAceiteTexto(valor: string): string[] {
  return valor
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

// ============================================================================
// Componente
// ============================================================================

export default function PlanoProjetoScreen(props: CustomScreenProps): ReactNode {
  const bundle = useApi()

  const idBruto = props.parentRow?.id ?? props.filterValue
  const projetoId = typeof idBruto === "number" ? idBruto : Number(idBruto)
  const projetoValido = Number.isFinite(projetoId) && projetoId > 0
  const nomeProjeto = texto(props.parentRow?.nome)

  const [geracoes, setGeracoes] = useState<Geracao[]>([])
  const [mensagens, setMensagens] = useState<MensagemChat[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erroCarga, setErroCarga] = useState<string | null>(null)

  const [editando, setEditando] = useState(false)
  const [tarefasEdit, setTarefasEdit] = useState<TarefaEdit[]>([])

  const [dialog, setDialog] = useState<"revise" | "reject" | null>(null)
  const [dialogTexto, setDialogTexto] = useState("")
  const [dialogErro, setDialogErro] = useState<string | null>(null)

  const [enviando, setEnviando] = useState<string | null>(null)
  const [erroDecisao, setErroDecisao] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const [chatTexto, setChatTexto] = useState("")
  const [chatEnviando, setChatEnviando] = useState(false)
  const [chatErro, setChatErro] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const base = projetoValido ? `/gerenteagentes/projetos-captados/${projetoId}` : null

  const carregar = useCallback(async () => {
    if (!bundle || !base) return
    setCarregando(true)
    setErroCarga(null)
    try {
      const [resGeracoes, resChat] = await Promise.all([
        bundle.http.request<Geracao[] | { geracoes?: Geracao[] }>("GET", `${base}/geracoes`, {
          auth: "access",
        }),
        bundle.http
          .request<MensagemChat[] | { mensagens?: MensagemChat[] }>("GET", `${base}/chat`, {
            auth: "access",
          })
          .catch(() => [] as MensagemChat[]),
      ])
      if (!mounted.current) return
      const listaGeracoes = Array.isArray(resGeracoes)
        ? resGeracoes
        : (comoRecord(resGeracoes)?.geracoes as Geracao[] | undefined) ?? []
      const listaChat = Array.isArray(resChat)
        ? resChat
        : (comoRecord(resChat)?.mensagens as MensagemChat[] | undefined) ?? []
      setGeracoes(comoArray(listaGeracoes) as Geracao[])
      setMensagens(comoArray(listaChat) as MensagemChat[])
    } catch (e) {
      if (mounted.current) {
        setErroCarga(e instanceof Error ? e.message : "Erro ao carregar as gerações do projeto")
      }
    } finally {
      if (mounted.current) setCarregando(false)
    }
  }, [bundle, base])

  useEffect(() => {
    void carregar()
  }, [carregar])

  // Geração mais recente (a API ordena por createdAt desc; [0] é a atual).
  const geracao = geracoes.length > 0 ? geracoes[0]! : null
  const status = texto(geracao?.status)
  const aguardandoAprovacao = status === "awaiting_approval"
  const plano = useMemo(() => extrairPlano(geracao?.tasks), [geracao])

  // Sai do modo edição quando a geração muda (ex.: após decisão/recarga).
  useEffect(() => {
    setEditando(false)
    setTarefasEdit([])
  }, [geracao?.id, status])

  const tarefasPlano = useMemo(() => comoArray(plano?.tarefas).map(comoRecord), [plano])

  function entrarEmEdicao(): void {
    const itens: TarefaEdit[] = tarefasPlano.map((t, i) => ({
      key: i,
      seq: Number(t?.seq) || i + 1,
      titulo: texto(t?.titulo),
      objetivo: texto(t?.objetivo),
      escopo: texto(t?.escopo),
      aceiteTexto: listaTextos(t?.aceite).join("\n"),
      dependeTexto: listaNumeros(t?.depende_de).join(", "),
      executor: texto(t?.executor),
      risco: texto(t?.risco),
      auto_start: t?.auto_start === true,
      requisitos: listaTextos(t?.requisitos),
    }))
    setTarefasEdit(itens)
    setEditando(true)
    setErroDecisao(null)
  }

  function sairDeEdicao(): void {
    setEditando(false)
    setTarefasEdit([])
  }

  function atualizarTarefa(index: number, campo: keyof TarefaEdit, valor: string): void {
    setTarefasEdit((atual) =>
      atual.map((t, i) => (i === index ? ({ ...t, [campo]: valor } as TarefaEdit) : t)),
    )
  }

  /** Reordena e re-numera seq, remapeando as referências de depende_de. */
  function moverTarefa(index: number, delta: number): void {
    setTarefasEdit((atual) => {
      const alvo = index + delta
      if (alvo < 0 || alvo >= atual.length) return atual
      const nova = [...atual]
      const [item] = nova.splice(index, 1)
      if (!item) return atual
      nova.splice(alvo, 0, item)
      const mapa = new Map<number, number>()
      nova.forEach((t, i) => mapa.set(t.seq, i + 1))
      return nova.map((t, i) => ({
        ...t,
        seq: i + 1,
        dependeTexto: parseDependeTexto(t.dependeTexto)
          .map((n) => mapa.get(n) ?? n)
          .join(", "),
      }))
    })
  }

  /** Plano integral modificado (contrato §5) a partir do estado de edição. */
  function montarPlanoEditado(): unknown {
    if (!plano) return undefined
    const tarefas = tarefasEdit.map((t, i) => ({
      seq: i + 1,
      titulo: t.titulo.trim(),
      objetivo: t.objetivo.trim(),
      escopo: t.escopo.trim(),
      aceite: parseAceiteTexto(t.aceiteTexto),
      requisitos: t.requisitos,
      executor: t.executor,
      depende_de: parseDependeTexto(t.dependeTexto),
      auto_start: t.auto_start,
      risco: t.risco,
    }))
    return { ...plano, tarefas }
  }

  async function decidir(
    decisao: "approve" | "revise" | "reject",
    opts: { comentario?: string; planoEditado?: unknown; chave: string } = { chave: decisao },
  ): Promise<boolean> {
    if (!bundle || !base || !geracao?.id) return false
    setEnviando(opts.chave)
    setErroDecisao(null)
    setAviso(null)
    try {
      const body: Record<string, unknown> = { decisao }
      if (opts.comentario && opts.comentario.trim() !== "") body.comentario = opts.comentario.trim()
      if (opts.planoEditado !== undefined) body.planoEditado = opts.planoEditado
      await bundle.http.request("POST", `${base}/geracoes/${geracao.id}/aprovar`, {
        auth: "access",
        body,
      })
      if (!mounted.current) return true
      sairDeEdicao()
      setDialog(null)
      setDialogTexto("")
      setDialogErro(null)
      setAviso(
        decisao === "approve"
          ? "Plano aprovado — tarefas macro materializadas."
          : decisao === "revise"
            ? "Revisão solicitada — a geração voltará a ser processada com o comentário."
            : "Plano rejeitado — nenhuma tarefa foi criada.",
      )
      await carregar()
      return true
    } catch (e) {
      if (mounted.current) {
        setErroDecisao(e instanceof Error ? e.message : "Erro ao registrar a decisão")
      }
      return false
    } finally {
      if (mounted.current) setEnviando(null)
    }
  }

  async function enviarChat(): Promise<void> {
    const textoMsg = chatTexto.trim()
    if (!bundle || !base || textoMsg === "" || chatEnviando) return
    setChatEnviando(true)
    setChatErro(null)
    try {
      await bundle.http.request("POST", `${base}/chat`, {
        auth: "access",
        body: { role: "user", texto: textoMsg },
      })
      if (!mounted.current) return
      setChatTexto("")
      // Recarrega chat e gerações: a resposta do usuário pode devolver a
      // geração awaiting_clarification → pending no backend.
      await carregar()
    } catch (e) {
      if (mounted.current) {
        setChatErro(e instanceof Error ? e.message : "Não foi possível enviar a mensagem.")
      }
    } finally {
      if (mounted.current) setChatEnviando(false)
    }
  }

  function abrirDialog(tipo: "revise" | "reject"): void {
    setDialog(tipo)
    setDialogTexto("")
    setDialogErro(null)
  }

  async function confirmarDialog(): Promise<void> {
    if (!dialog) return
    const comentario = dialogTexto.trim()
    if (dialog === "revise" && comentario === "") {
      setDialogErro("O comentário é obrigatório para pedir revisão.")
      return
    }
    const ok = await decidir(dialog, { comentario: comentario || undefined, chave: dialog })
    if (!ok && dialog === "revise" && comentario === "") {
      setDialogErro("O comentário é obrigatório para pedir revisão.")
    }
  }

  // ==========================================================================
  // Render
  // ==========================================================================

  if (!bundle) {
    return (
      <Stack spacing={2} sx={{ p: 2 }}>
        <CircularProgress data-testid="carregando-bundle" />
      </Stack>
    )
  }

  if (!projetoValido) {
    return (
      <Stack spacing={2} sx={{ p: 2 }}>
        <Alert severity="warning" data-testid="sem-projeto">
          Abra o painel “Plano do projeto” a partir da linha de um projeto captado.
        </Alert>
      </Stack>
    )
  }

  const infoStatus = STATUS_INFO[status] ?? { label: status || "desconhecido", cor: "default" as CorChip }
  const requisitos = comoArray(plano?.requisitos).map(comoRecord)
  const especificacao = comoRecord(plano?.especificacaoCrud)
  const entidades = comoArray(especificacao?.entidades).map(comoRecord)
  const matriz = comoArray(plano?.matrizCobertura).map(comoRecord)
  const lacunas = listaTextos(plano?.lacunas)
  const lacunasBib = comoArray(plano?.lacunasBiblioteca).map(comoRecord)
  const riscos = listaTextos(plano?.riscos)
  const foraDeFase = comoArray(plano?.foraDeFase).map(comoRecord)
  const materializacao = comoRecord(plano?.materializacao)
  const tarefasMaterializadas = comoArray(materializacao?.tarefas).map(comoRecord)

  return (
    <Stack spacing={2} sx={{ p: 2 }} data-testid="plano-projeto-screen">
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="h6">
          Plano do projeto{nomeProjeto ? ` — ${nomeProjeto}` : ""}
        </Typography>
        <Button size="small" onClick={() => void carregar()} disabled={carregando}>
          Atualizar
        </Button>
      </Stack>

      {erroCarga && (
        <Alert severity="error" data-testid="erro-carga">{erroCarga}</Alert>
      )}
      {erroDecisao && (
        <Alert severity="error" data-testid="erro-decisao" onClose={() => setErroDecisao(null)}>
          {erroDecisao}
        </Alert>
      )}
      {aviso && (
        <Alert severity="success" data-testid="aviso-decisao" onClose={() => setAviso(null)}>
          {aviso}
        </Alert>
      )}

      {carregando && geracoes.length === 0 ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress data-testid="carregando" />
        </Stack>
      ) : !geracao ? (
        <Alert severity="info" data-testid="sem-geracao">
          Nenhuma geração encontrada para este projeto ainda.
        </Alert>
      ) : (
        <>
          {/* ---- Estado da geração ---- */}
          <Paper variant="outlined" sx={{ p: 2 }} data-testid="painel-geracao">
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1">Geração #{texto(geracao.id)}</Typography>
              <Chip
                size="small"
                label={infoStatus.label}
                color={infoStatus.cor}
                data-testid="status-geracao"
              />
              {plano && texto(plano.classificacaoSistema) && (
                <Chip size="small" variant="outlined" label={texto(plano.classificacaoSistema)} data-testid="classificacao-sistema" />
              )}
              {plano && typeof plano.requerAgenteDedicado === "boolean" && (
                <Chip
                  size="small"
                  variant="outlined"
                  color={plano.requerAgenteDedicado ? "primary" : "default"}
                  label={plano.requerAgenteDedicado ? "Requer agente dedicado" : "Sem agente dedicado"}
                  data-testid="requer-agente"
                />
              )}
              {texto(geracao.modelo) && (
                <Chip size="small" variant="outlined" label={`Modelo: ${texto(geracao.modelo)}`} />
              )}
              {texto(geracao.updatedAt) && (
                <Typography variant="caption" color="text.secondary">
                  Atualizada em {formatarData(geracao.updatedAt)}
                </Typography>
              )}
            </Stack>
            {status === "failed" && texto(geracao.erro) && (
              <Alert severity="error" sx={{ mt: 1 }} data-testid="erro-geracao">
                {texto(geracao.erro)}
              </Alert>
            )}
            {texto(geracao.feedback) && (
              <Alert severity="info" sx={{ mt: 1 }} data-testid="feedback-geracao">
                Feedback da última revisão: {texto(geracao.feedback)}
              </Alert>
            )}
            {status === "awaiting_clarification" && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                A geração está aguardando clarificação — responda no chat abaixo para destravar.
              </Alert>
            )}

            {/* ---- Decisões (somente awaiting_approval) ---- */}
            {aguardandoAprovacao && !editando && (
              <Stack direction="row" spacing={1} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
                <Button
                  variant="contained"
                  color="success"
                  startIcon={<CheckRounded />}
                  data-testid="btn-aprovar"
                  disabled={enviando !== null}
                  onClick={() => void decidir("approve", { chave: "approve" })}
                >
                  {enviando === "approve" ? "Aprovando..." : "Aprovar"}
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<EditRounded />}
                  data-testid="btn-editar"
                  disabled={enviando !== null || !plano}
                  onClick={entrarEmEdicao}
                >
                  Editar
                </Button>
                <Button
                  variant="outlined"
                  color="warning"
                  startIcon={<RateReviewRounded />}
                  data-testid="btn-revisar"
                  disabled={enviando !== null}
                  onClick={() => abrirDialog("revise")}
                >
                  Pedir revisão
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<CloseRounded />}
                  data-testid="btn-rejeitar"
                  disabled={enviando !== null}
                  onClick={() => abrirDialog("reject")}
                >
                  Rejeitar
                </Button>
              </Stack>
            )}
          </Paper>

          {/* ---- Plano ---- */}
          {!plano ? (
            <Alert severity="info" data-testid="sem-plano">
              Sem plano registrado para esta geração.
            </Alert>
          ) : (
            <>
              {/* Requisitos */}
              <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-requisitos">
                <Typography variant="subtitle2" gutterBottom>
                  Requisitos ({requisitos.length})
                </Typography>
                {requisitos.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>ID</TableCell>
                          <TableCell>Texto</TableCell>
                          <TableCell>Origem</TableCell>
                          <TableCell>Classificação</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {requisitos.map((req, i) => {
                          const classificacao = texto(req?.classificacao)
                          return (
                            <TableRow key={texto(req?.id) || i}>
                              <TableCell sx={{ whiteSpace: "nowrap" }}>{texto(req?.id)}</TableCell>
                              <TableCell>{texto(req?.texto)}</TableCell>
                              <TableCell>{texto(req?.origem) || "—"}</TableCell>
                              <TableCell>
                                {classificacao ? (
                                  <Chip
                                    size="small"
                                    label={classificacao}
                                    color={COR_CLASSIFICACAO_REQ[classificacao] ?? "default"}
                                  />
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Paper>

              {/* Tarefas */}
              <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-tarefas">
                <Typography variant="subtitle2" gutterBottom>
                  Tarefas do plano ({editando ? tarefasEdit.length : tarefasPlano.length})
                </Typography>
                {!editando && tarefasPlano.length === 0 && (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                )}
                {!editando &&
                  tarefasPlano.map((t, i) => {
                    const risco = texto(t?.risco)
                    return (
                      <Box key={i} sx={{ mb: 1.5 }} data-testid={`tarefa-${i}`}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="subtitle2">
                            {Number(t?.seq) || i + 1}. {texto(t?.titulo) || "(sem título)"}
                          </Typography>
                          {texto(t?.executor) && (
                            <Chip size="small" variant="outlined" label={texto(t?.executor)} />
                          )}
                          {risco && (
                            <Chip size="small" label={`risco ${risco}`} color={COR_RISCO[risco] ?? "default"} />
                          )}
                          {t?.auto_start === true && (
                            <Chip size="small" variant="outlined" label="auto_start" />
                          )}
                        </Stack>
                        {texto(t?.objetivo) && (
                          <Typography variant="body2" color="text.secondary">
                            Objetivo: {texto(t?.objetivo)}
                          </Typography>
                        )}
                        {texto(t?.escopo) && (
                          <Typography variant="body2" color="text.secondary">
                            Escopo: {texto(t?.escopo)}
                          </Typography>
                        )}
                        {listaTextos(t?.aceite).length > 0 && (
                          <Typography variant="body2" color="text.secondary">
                            Aceite: {listaTextos(t?.aceite).join(" · ")}
                          </Typography>
                        )}
                        <Typography variant="caption" color="text.secondary">
                          Requisitos: {listaTextos(t?.requisitos).join(", ") || "—"} · Depende de:{" "}
                          {listaNumeros(t?.depende_de).join(", ") || "nenhuma"}
                        </Typography>
                        {i < tarefasPlano.length - 1 && <Divider sx={{ mt: 1 }} />}
                      </Box>
                    )
                  })}
                {editando &&
                  tarefasEdit.map((t, i) => (
                    <Paper key={t.key} variant="outlined" sx={{ p: 1.5, mb: 1.5 }} data-testid={`tarefa-edit-${i}`}>
                      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                        <Typography variant="subtitle2">Seq {i + 1}</Typography>
                        <Stack direction="row" spacing={0.5}>
                          <IconButton
                            size="small"
                            data-testid={`mover-cima-${i}`}
                            disabled={i === 0}
                            onClick={() => moverTarefa(i, -1)}
                          >
                            <ArrowUpwardRounded fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            data-testid={`mover-baixo-${i}`}
                            disabled={i === tarefasEdit.length - 1}
                            onClick={() => moverTarefa(i, 1)}
                          >
                            <ArrowDownwardRounded fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>
                      <Stack spacing={1.5} sx={{ mt: 1 }}>
                        <TextField
                          size="small"
                          label="Título"
                          value={t.titulo}
                          data-testid={`edit-titulo-${i}`}
                          onChange={(e) => atualizarTarefa(i, "titulo", e.target.value)}
                          fullWidth
                        />
                        <TextField
                          size="small"
                          label="Escopo"
                          value={t.escopo}
                          data-testid={`edit-escopo-${i}`}
                          onChange={(e) => atualizarTarefa(i, "escopo", e.target.value)}
                          fullWidth
                          multiline
                          minRows={2}
                        />
                        <TextField
                          size="small"
                          label="Aceite (um item por linha)"
                          value={t.aceiteTexto}
                          data-testid={`edit-aceite-${i}`}
                          onChange={(e) => atualizarTarefa(i, "aceiteTexto", e.target.value)}
                          fullWidth
                          multiline
                          minRows={2}
                        />
                        <TextField
                          size="small"
                          label="Depende de (seqs separados por vírgula)"
                          value={t.dependeTexto}
                          data-testid={`edit-depende-${i}`}
                          onChange={(e) => atualizarTarefa(i, "dependeTexto", e.target.value)}
                          fullWidth
                        />
                        <Typography variant="caption" color="text.secondary">
                          Executor: {t.executor || "—"} · Risco: {t.risco || "—"} · Requisitos:{" "}
                          {t.requisitos.join(", ") || "—"}
                        </Typography>
                      </Stack>
                    </Paper>
                  ))}
                {editando && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                    <Button
                      variant="contained"
                      color="success"
                      startIcon={<CheckRounded />}
                      data-testid="btn-salvar-aprovar"
                      disabled={enviando !== null}
                      onClick={() =>
                        void decidir("approve", {
                          planoEditado: montarPlanoEditado(),
                          chave: "approve-edit",
                        })
                      }
                    >
                      {enviando === "approve-edit" ? "Salvando..." : "Salvar e aprovar"}
                    </Button>
                    <Button
                      variant="outlined"
                      data-testid="btn-cancelar-edicao"
                      disabled={enviando !== null}
                      onClick={sairDeEdicao}
                    >
                      Cancelar edição
                    </Button>
                  </Stack>
                )}
              </Paper>

              {/* Especificação CRUD */}
              <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-especificacao-crud">
                <Typography variant="subtitle2" gutterBottom>
                  Especificação CRUD
                </Typography>
                {entidades.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                ) : (
                  entidades.map((ent, i) => (
                    <Box key={i} sx={{ mb: 1 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {texto(ent?.nome) || `Entidade ${i + 1}`}
                        {texto(ent?.menu) ? ` (menu: ${texto(ent?.menu)})` : ""}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Campos: {listaTextos(ent?.campos).join(", ") || "—"}
                      </Typography>
                      {listaTextos(ent?.mascarasValidacoes).length > 0 && (
                        <Typography variant="body2" color="text.secondary">
                          Máscaras/validações: {listaTextos(ent?.mascarasValidacoes).join(" · ")}
                        </Typography>
                      )}
                    </Box>
                  ))
                )}
                {texto(especificacao?.observacoes) && (
                  <Typography variant="caption" color="text.secondary">
                    Observações: {texto(especificacao?.observacoes)}
                  </Typography>
                )}
              </Paper>

              {/* Matriz de cobertura */}
              <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-matriz-cobertura">
                <Typography variant="subtitle2" gutterBottom>
                  Matriz de cobertura ({matriz.length})
                </Typography>
                {matriz.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">—</Typography>
                ) : (
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>Requisito</TableCell>
                          <TableCell>Coberto por</TableCell>
                          <TableCell>Justificativa</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {matriz.map((m, i) => (
                          <TableRow key={i}>
                            <TableCell>{texto(m?.req)}</TableCell>
                            <TableCell>{texto(m?.cobertoPor)}</TableCell>
                            <TableCell>{texto(m?.justificativa) || "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
              </Paper>

              {/* Lacunas / lacunas da biblioteca / riscos / fora de fase */}
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }} data-testid="secao-lacunas">
                  <Typography variant="subtitle2" gutterBottom>
                    Lacunas ({lacunas.length})
                  </Typography>
                  {lacunas.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">—</Typography>
                  ) : (
                    lacunas.map((l, i) => (
                      <Typography key={i} variant="body2">• {l}</Typography>
                    ))
                  )}
                </Paper>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }} data-testid="secao-lacunas-biblioteca">
                  <Typography variant="subtitle2" gutterBottom>
                    Lacunas da Biblioteca ({lacunasBib.length})
                  </Typography>
                  {lacunasBib.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">—</Typography>
                  ) : (
                    lacunasBib.map((l, i) => (
                      <Box key={i} sx={{ mb: 0.5 }}>
                        <Typography variant="body2">
                          • {texto(l?.funcionalidade)}
                          {texto(l?.req) ? ` (${texto(l?.req)})` : ""}
                        </Typography>
                        {texto(l?.contexto) && (
                          <Typography variant="caption" color="text.secondary">
                            {texto(l?.contexto)}
                          </Typography>
                        )}
                      </Box>
                    ))
                  )}
                </Paper>
              </Stack>
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }} data-testid="secao-riscos">
                  <Typography variant="subtitle2" gutterBottom>
                    Riscos ({riscos.length})
                  </Typography>
                  {riscos.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">—</Typography>
                  ) : (
                    riscos.map((r, i) => (
                      <Typography key={i} variant="body2">• {r}</Typography>
                    ))
                  )}
                </Paper>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }} data-testid="secao-fora-de-fase">
                  <Typography variant="subtitle2" gutterBottom>
                    Fora de fase ({foraDeFase.length})
                  </Typography>
                  {foraDeFase.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">—</Typography>
                  ) : (
                    foraDeFase.map((f, i) => (
                      <Typography key={i} variant="body2">
                        • {texto(f?.req)}: {texto(f?.motivo)}
                      </Typography>
                    ))
                  )}
                </Paper>
              </Stack>

              {/* Materialização (pós-approve) */}
              {materializacao && (
                <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-materializacao">
                  <Typography variant="subtitle2" gutterBottom>
                    Materialização
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Aprovado por {texto(materializacao.aprovadoPor) || "—"} em{" "}
                    {formatarData(materializacao.aprovadoEm) || "—"}
                    {texto(materializacao.comentario) ? ` · comentário: ${texto(materializacao.comentario)}` : ""}
                  </Typography>
                  {tarefasMaterializadas.map((t, i) => (
                    <Typography key={i} variant="body2">
                      • {texto(t?.externalId) || `#${texto(t?.id)}`}: {texto(t?.titulo)}{" "}
                      [{texto(t?.executor)}]
                      {t?.criada === false ? " (reutilizada)" : ""}
                    </Typography>
                  ))}
                </Paper>
              )}
            </>
          )}
        </>
      )}

      {/* ---- Chat de clarificação ---- */}
      <Paper variant="outlined" sx={{ p: 2 }} data-testid="secao-chat">
        <Typography variant="subtitle2" gutterBottom>
          Chat de clarificação
        </Typography>
        {chatErro && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setChatErro(null)}>
            {chatErro}
          </Alert>
        )}
        {mensagens.length === 0 ? (
          <Typography variant="body2" color="text.secondary" data-testid="chat-vazio">
            Nenhuma mensagem ainda.
          </Typography>
        ) : (
          <Stack spacing={1} sx={{ mb: 2, maxHeight: 320, overflowY: "auto" }} data-testid="chat-mensagens">
            {mensagens.map((m, i) => {
              const role = texto(m.role) || "system"
              return (
                <Box key={m.id ?? i} data-testid={`chat-msg-${i}`}>
                  <Stack direction="row" spacing={1} alignItems="baseline">
                    <Chip size="small" label={role} color={COR_ROLE_CHAT[role] ?? "default"} />
                    {texto(m.createdAt) && (
                      <Typography variant="caption" color="text.secondary">
                        {formatarData(m.createdAt)}
                      </Typography>
                    )}
                  </Stack>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", ml: 0.5 }}>
                    {texto(m.texto)}
                  </Typography>
                </Box>
              )
            })}
          </Stack>
        )}
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={1}
            maxRows={4}
            placeholder="Escreva sua resposta/resposta de clarificação..."
            value={chatTexto}
            data-testid="chat-input"
            onChange={(e) => setChatTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void enviarChat()
              }
            }}
          />
          <Button
            variant="contained"
            startIcon={<SendRounded />}
            data-testid="chat-enviar"
            disabled={chatEnviando || chatTexto.trim() === ""}
            onClick={() => void enviarChat()}
          >
            Enviar
          </Button>
        </Stack>
      </Paper>

      {/* ---- Dialogs de revisão/rejeição ---- */}
      <Dialog open={dialog !== null} onClose={() => setDialog(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {dialog === "revise" ? "Pedir revisão do plano" : "Rejeitar plano"}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {dialog === "revise"
              ? "A geração voltará a ser processada pelo analista com o seu comentário como feedback."
              : "Nenhuma tarefa será criada. O comentário é opcional."}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label={dialog === "revise" ? "Comentário (obrigatório)" : "Comentário (opcional)"}
            value={dialogTexto}
            data-testid="dialog-comentario"
            onChange={(e) => {
              setDialogTexto(e.target.value)
              setDialogErro(null)
            }}
            error={dialogErro !== null}
            helperText={dialogErro ?? undefined}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)} data-testid="dialog-cancelar">
            Cancelar
          </Button>
          <Button
            variant="contained"
            color={dialog === "revise" ? "warning" : "error"}
            data-testid="dialog-confirmar"
            disabled={enviando !== null}
            onClick={() => void confirmarDialog()}
          >
            {enviando === dialog ? "Enviando..." : "Confirmar"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
