/**
 * VisoesTarefasScreen — "Visões" por área e por categoria (tags)
 * (gestao-de-tarefas-global — macro #8, subtarefa 2; REQ-F-004).
 *
 * Dois modos (mesma tela registrada uma vez — `componentId` único):
 *
 * (a) SEM props (item de menu "Visões", grupo "Tarefas"):
 *     - SEÇÕES "Por área" e "Por tag" — grupos com chips/contagens
 *       `pendentes`/`vencidas` vindos de GET `/:slug/visoes/resumo`
 *       (subtarefa 1) — o front NUNCA recalcula: as contagens são do
 *       servidor (relógio do servidor);
 *     - clique num grupo abre o DRILL internamente (estado local
 *       `drill` — sem navegar para a grid de cadastro).
 *
 * (b) COM props `filterField: "areaId" | "tagId"` + `filterValue`
 *     (childRoutes da grid de Áreas/Tags, `targetResource: "tarefas"`):
 *     - DRILL direto na lista de tarefas do grupo via GET
 *       `/:slug/visoes/tarefas?areaId=|tagId=&status=&prazo=&responsavelId=`;
 *     - filtros rápidos na UI (todos enviados como QUERY ao servidor):
 *       status (multi — pendentes por padrão), prazo (bucket) e
 *       responsável (incl. "eu" — colaborador da sessão resolvido via
 *       `sub` do access token + GET `/:slug/colaboradores?usuarioId=`).
 *
 * Convenções (espelham DashboardScreen/TarefaFluxoScreen):
 * - UI não fala HTTP diretamente: tudo pelo `bundle.http` do useApi;
 * - `useRef` de montagem para não setState após desmontar;
 * - parsing tolerante (array cru ou { items });
 * - MUI Grid v2 com `size={{xs,md}}` (sem `item` — MUI 7), alvos de
 *   toque ≥44px, sem quebra de layout em viewport ~360px.
 *
 * Estados carregando/vazio/erro: CircularProgress / Alert sucesso /
 * Alert erro com mensagem LITERAL da API + botão "Tentar novamente".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material"
import { ArrowForwardRounded, RefreshRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import type { CustomScreenProps } from "@biblioteca-global/ui"

export const componentId = "gestao-de-tarefas-global-visoes"

const SLUG = "gestao-de-tarefas-global"

// ============================================================================
// Tipos das respostas da API (espelham a subtarefa 1 — sem import de apps)
// ============================================================================

/** Grupo (área ou tag) do resumo — contagens calculadas no SERVIDOR. */
type GrupoResumo = {
  id: number
  nome: string
  total: number
  pendentes: number
  vencidas: number
}

type ResumoVisoes = {
  areas: GrupoResumo[]
  tags: GrupoResumo[]
}

/** Item da lista da visão — espelha ItemTarefaVisao (subtarefa 1). */
type TarefaVisao = {
  id: number
  titulo: string
  descricao: string | null
  prioridade: string
  /** String do banco (`YYYY-MM-DD HH:mm:ss`, relógio do servidor) ou null. */
  prazo: string | null
  status: string
  areaId: number | null
  areaNome: string | null
  responsavelId: number | null
  responsavelNome: string | null
}

type ListaTarefasVisao = { items: TarefaVisao[]; total: number }

/** Opcional de responsável do seletor. */
type ColaboradorOpcao = {
  id: number
  nome: string
}

// ============================================================================
// Filtros rápidos — rótulos locais; os VALORES são os do contrato da API
// (subtarefa 1): status ∈ enum de tarefas; prazo ∈ vencida|hoje|semana|sem_prazo.
// ============================================================================

type CampoFiltro = "areaId" | "tagId"

const STATUS_PENDENTES = ["aberta", "delegada", "precisa_informacoes", "aguardando_terceiro"]

const OPCOES_STATUS: Array<{ value: string; label: string }> = [
  { value: "pendentes", label: "Pendentes" },
  { value: "aberta", label: "Aberta" },
  { value: "delegada", label: "Delegada" },
  { value: "precisa_informacoes", label: "Precisa de informações" },
  { value: "aguardando_terceiro", label: "Aguardando terceiro" },
  { value: "concluida", label: "Concluída" },
  { value: "cancelada", label: "Cancelada" },
]

/** "pendentes" (agrupamento local) resolve no multi de status da API. */
function resolverStatusParaQuery(valor: string | null): string[] {
  if (!valor) return STATUS_PENDENTES
  if (valor === "pendentes") return STATUS_PENDENTES
  return [valor]
}

const OPCOES_PRAZO: Array<{ value: string; label: string }> = [
  { value: "", label: "Todas" },
  { value: "vencida", label: "Vencidas" },
  { value: "hoje", label: "Vence hoje" },
  { value: "semana", label: "Próximos 7 dias" },
  { value: "sem_prazo", label: "Sem prazo" },
]

const ROTULO_STATUS: Record<string, string> = Object.fromEntries(
  OPCOES_STATUS.map((o) => [o.value, o.label]),
)

const ROTULO_PRIORIDADE: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  urgente: "Urgente",
}

// ============================================================================
// Helpers (tolerantes — espelham DashboardScreen)
// ============================================================================

const FORMATADOR_PRAZO = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
})

function formatarPrazo(iso: string | null | undefined): string {
  if (!iso) return "Sem prazo"
  const normalizado = iso.includes("T") ? iso : iso.replace(" ", "T")
  const d = new Date(normalizado)
  return Number.isNaN(d.getTime()) ? String(iso) : FORMATADOR_PRAZO.format(d)
}

/** `prazo` do banco é "YYYY-MM-DD HH:mm:ss" SEM fuso — relógio do servidor. */
function prazoEhVencida(iso: string | null | undefined, agora: number): boolean {
  if (!iso) return false
  const normalizado = iso.includes("T") ? iso : iso.replace(" ", "T")
  const t = Date.parse(`${normalizado}Z`)
  return Number.isFinite(t) && t < agora
}

/** Aceita array cru ou `{ items }` — preserva T; T={} para payloads cruos. */
function comoLista<T>(bruto: unknown): T[] {
  if (Array.isArray(bruto)) return bruto as T[]
  if (bruto && typeof bruto === "object") {
    const items = (bruto as { items?: T[] }).items
    if (Array.isArray(items)) return items
  }
  return []
}

function comoResumo(bruto: unknown): ResumoVisoes | null {
  if (!bruto || typeof bruto !== "object") return null
  const obj = bruto as Partial<ResumoVisoes>
  if (!Array.isArray(obj.areas) || !Array.isArray(obj.tags)) return null
  return {
    areas: obj.areas as GrupoResumo[],
    tags: obj.tags as GrupoResumo[],
  }
}

function mensagemErro(erro: unknown): string {
  return erro instanceof Error && erro.message
    ? erro.message
    : "Não foi possível completar a operação."
}

/** `sub` (id do usuário global) do access token — vínculo do colaborador. */
function subDoAccessToken(token: string | null): number | null {
  if (!token) return null
  const partes = token.split(".")
  if (partes.length !== 3 || !partes[1]) return null
  try {
    const decodificado = JSON.parse(
      decodeURIComponent(
        Array.from(atob(partes[1]), (c) =>
          `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
        ).join(""),
      ),
    ) as { sub?: unknown }
    const sub = decodificado?.sub
    if (typeof sub === "number" && Number.isFinite(sub) && sub > 0) return sub
    if (typeof sub === "string" && /^\d+$/.test(sub) && Number(sub) > 0) {
      return Number(sub)
    }
  } catch {
    // token inválido/sem payload — sem "eu".
  }
  return null
}

// ============================================================================
// Componente
// ============================================================================

export default function VisoesTarefasScreen(props: CustomScreenProps): ReactNode {
  const bundle = useApi()

  // Modo (b): childRoutes da grid de Áreas/Tags injetam o filtro do grupo.
  // `nome` vazio → a API é a fonte do rótulo (resumo/linha do grupo).
  const filtroInicial: { campo: CampoFiltro; id: number; nome: string } | null = useMemo(() => {
    if (props.filterField === "areaId" || props.filterField === "tagId") {
      const id = Number(props.filterValue)
      if (Number.isFinite(id) && id > 0) return { campo: props.filterField, id, nome: "" }
    }
    return null
    // props de childRoute são estáveis por navegação.
  }, [props.filterField, props.filterValue])

  const [drill, setDrill] = useState<{ campo: CampoFiltro; id: number; nome: string } | null>(
    filtroInicial,
  )
  const [status, setStatus] = useState<string>("pendentes")
  const [prazo, setPrazo] = useState<string>("")
  const [responsavelId, setResponsavelId] = useState<string>("")

  const [resumo, setResumo] = useState<ResumoVisoes | null>(null)
  const [tarefas, setTarefas] = useState<TarefaVisao[]>([])
  const [colaboradores, setColaboradores] = useState<ColaboradorOpcao[]>([])
  const [euId, setEuId] = useState<number | null>(null)
  const [carregando, setCarregando] = useState(true)
  const [erroCarga, setErroCarga] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const resumoNecessario = drill == null
  const carregarResumo = useCallback(async () => {
    if (!bundle) return
    setErroCarga(null)
    try {
      const res = await bundle.http.request<unknown>("GET", `/${SLUG}/visoes/resumo`, {
        auth: "access",
      })
      if (!mounted.current) return
      setResumo(comoResumo(res))
    } catch (erro) {
      if (mounted.current) setErroCarga(mensagemErro(erro))
    }
  }, [bundle])

  // Colaboradores ATIVOS da organização (para o seletor de responsável) —
  // mesmo padrão da delegação do TarefaFluxoScreen; "eu" resolve pelo `sub`.
  const colaboradoresCarregados = useRef(false)
  const carregarColaboradores = useCallback(async () => {
    if (!bundle || colaboradoresCarregados.current) return
    colaboradoresCarregados.current = true
    try {
      const res = await bundle.http.request<ColaboradorOpcao[] | { items?: ColaboradorOpcao[] }>(
        "GET",
        `/${SLUG}/colaboradores`,
        { auth: "access", query: { ativo: "true", pageSize: 200 } },
      )
      if (!mounted.current) return
      // Cast explícito: comoLista preserva T, mas o TS 6 não propaga a
      // narrowing do union na inferência de retorno (idioma do repo).
      const lista = comoLista<ColaboradorOpcao>(
        res as ColaboradorOpcao[] | { items: ColaboradorOpcao[] },
      ).map((c) => ({ id: Number(c?.id), nome: String(c?.nome ?? "") }))
      setColaboradores(lista)
      const sub = subDoAccessToken(bundle.getAccessToken() ?? null)
      if (sub != null) {
        const eu = lista.find((c) => c.id === sub)
        if (eu) setEuId(eu.id)
      }
    } catch {
      // Sem colaborador ativo na sessão → seletor segue funcional (sem "eu").
      colaboradoresCarregados.current = false
    }
  }, [bundle])

  const carregarTarefas = useCallback(
    async (campo: CampoFiltro, id: number) => {
      if (!bundle) return
      setErroCarga(null)
      const query: Record<string, string | number | boolean | undefined> = {
        [campo]: id,
        status: resolverStatusParaQuery(status).join(","),
        responsavelId: responsavelId === "" ? undefined : Number(responsavelId),
      }
      if (prazo) query.prazo = prazo
      try {
        const res = await bundle.http.request<ListaTarefasVisao | TarefaVisao[]>(
          "GET",
          `/${SLUG}/visoes/tarefas`,
          { auth: "access", query },
        )
        if (!mounted.current) return
        setTarefas(comoLista<TarefaVisao>(res))
      } catch (erro) {
        if (mounted.current) setErroCarga(mensagemErro(erro))
      }
    },
    [bundle, status, prazo, responsavelId],
  )

  // Modo (a): carrega o resumo das duas seções.
  useEffect(() => {
    if (!resumoNecessario) return
    setCarregando(true)
    void Promise.all([carregarResumo(), carregarColaboradores()]).finally(() => {
      if (mounted.current) setCarregando(false)
    })
  }, [resumoNecessario, carregarResumo, carregarColaboradores])

  // Modo (b): lista do grupo + responsáveis (se "eu" ainda não resolvido).
  useEffect(() => {
    if (drill == null) return
    setCarregando(true)
    void Promise.all([
      carregarTarefas(drill.campo, drill.id),
      euId == null ? carregarColaboradores() : Promise.resolve(),
    ]).finally(() => {
      if (mounted.current) setCarregando(false)
    })
  }, [drill, carregarTarefas, carregarColaboradores, euId])

  const abrirGrupo = useCallback((campo: CampoFiltro, grupo: GrupoResumo): void => {
    setDrill({ campo, id: Number(grupo.id), nome: grupo.nome })
  }, [])

  const voltarGrupos = useCallback((): void => {
    setDrill(null)
  }, [])

  const tentarnovamente = useCallback((): void => {
    if (!drill) void carregarResumo()
    else void carregarTarefas(drill.campo, drill.id)
  }, [drill, carregarResumo, carregarTarefas])

  const agora = Date.now()

  // ============================================================================
  // Filtros rápidos (compartilhados — drill interno e childRoute)
  // ============================================================================

  const filtrosRapidos = (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }} data-testid="visoes-filtros">
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {OPCOES_STATUS.map((opcao) => (
            <Chip
              key={opcao.value}
              label={opcao.label}
              size="medium"
              variant={status === opcao.value ? "filled" : "outlined"}
              color={status === opcao.value ? "primary" : "default"}
              onClick={() => setStatus(opcao.value)}
              sx={{ minHeight: 40 }}
              data-testid={`visoes-chip-status-${opcao.value}`}
            />
          ))}
        </Stack>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          alignItems={{ xs: "stretch", sm: "center" }}
        >
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ flexGrow: 1 }}>
            {OPCOES_PRAZO.map((opcao) => (
              <Chip
                key={opcao.value}
                label={opcao.label}
                size="medium"
                variant={prazo === opcao.value ? "filled" : "outlined"}
                color={prazo === opcao.value ? "primary" : "default"}
                onClick={() => setPrazo(opcao.value)}
                sx={{ minHeight: 40 }}
                data-testid={`visoes-chip-prazo-${opcao.value === "" ? "todas" : opcao.value}`}
              />
            ))}
          </Stack>
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 220 } }} data-testid="visoes-responsavel">
            <InputLabel id="visoes-responsavel-label">Responsável</InputLabel>
            <Select
              labelId="visoes-responsavel-label"
              label="Responsável"
              value={responsavelId}
              onChange={(e) => setResponsavelId(e.target.value)}
            >
              <MenuItem value="">Todos</MenuItem>
              {euId != null && (
                <MenuItem value={String(euId)} data-testid="visoes-responsavel-eu">
                  Eu
                </MenuItem>
              )}
              {colaboradores
                .filter((c) => c.id !== euId)
                .map((c) => (
                  <MenuItem key={c.id} value={String(c.id)}>
                    {c.nome}
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
        </Stack>
      </Stack>
    </Paper>
  )

  // ============================================================================
  // Modo (b) — drill: lista de tarefas do grupo
  // ============================================================================

  if (drill != null) {
    return (
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            startIcon={<RefreshRounded style={{ transform: "rotate(180deg)" }} />}
            onClick={voltarGrupos}
            sx={{ minHeight: 44 }}
            data-testid="visoes-voltar"
          >
            Visões
          </Button>
          <Typography variant="h5" sx={{ flexGrow: 1, overflowWrap: "anywhere" }}>
            {drill.campo === "areaId" ? "Área" : "Tag"}: {drill.nome}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
            {tarefas.length} tarefa{tarefas.length === 1 ? "" : "s"}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshRounded />}
            onClick={() => void carregarTarefas(drill.campo, drill.id)}
            disabled={carregando}
            sx={{ minHeight: 44 }}
            data-testid="visoes-atualizar"
          >
            Atualizar
          </Button>
        </Stack>

        {erroCarga && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={tentarnovamente} sx={{ minHeight: 36 }}>
                Tentar novamente
              </Button>
            }
            data-testid="visoes-erro"
          >
            {erroCarga}
          </Alert>
        )}

        {filtrosRapidos}

        {carregando && tarefas.length === 0 ? (
          <Box
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", py: 8, gap: 2 }}
            data-testid="visoes-carregando"
          >
            <CircularProgress size={36} />
            <Typography color="text.secondary">Carregando tarefas...</Typography>
          </Box>
        ) : !carregando && tarefas.length === 0 && !erroCarga ? (
          <Alert severity="success" data-testid="visoes-vazio">
            Nenhuma tarefa neste grupo com os filtros atuais.
          </Alert>
        ) : (
          <Stack spacing={1.5}>
            {tarefas.map((tarefa) => {
              const vencida = prazoEhVencida(tarefa.prazo, agora)
              return (
                <Paper key={tarefa.id} variant="outlined" sx={{ p: 2 }} data-testid={`visoes-tarefa-${tarefa.id}`}>
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography
                        variant="h6"
                        sx={{ flexGrow: 1, minWidth: "55%", overflowWrap: "anywhere" }}
                        data-testid={`visoes-tarefa-titulo-${tarefa.id}`}
                      >
                        {tarefa.titulo}
                      </Typography>
                      <Chip
                        label={ROTULO_STATUS[tarefa.status] ?? tarefa.status}
                        size="small"
                        variant="outlined"
                      />
                      <Chip
                        label={ROTULO_PRIORIDADE[tarefa.prioridade] ?? tarefa.prioridade}
                        size="small"
                        variant="outlined"
                      />
                    </Stack>
                    {tarefa.descricao && (
                      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                        {tarefa.descricao}
                      </Typography>
                    )}
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {tarefa.areaNome && (
                        <Chip label={tarefa.areaNome} size="small" variant="outlined" />
                      )}
                      <Typography
                        variant="body2"
                        color={vencida ? "error" : "text.secondary"}
                        sx={{ fontWeight: vencida ? 700 : 400 }}
                        data-testid={`visoes-tarefa-prazo-${tarefa.id}`}
                      >
                        Prazo: {formatarPrazo(tarefa.prazo)}
                        {vencida ? " · Vencida" : ""}
                      </Typography>
                      {tarefa.responsavelNome && (
                        <Typography variant="body2" color="text.secondary">
                          Responsável: {tarefa.responsavelNome}
                        </Typography>
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              )
            })}
          </Stack>
        )}
      </Stack>
    )
  }

  // ============================================================================
  // Modo (a) — agrupamentos: seções "Por área" e "Por tag"
  // ============================================================================

  const secaoGrupo = (
    titulo: string,
    grupos: GrupoResumo[] | undefined,
    campo: CampoFiltro,
  ): ReactNode => (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }} data-testid={`visoes-secao-${titulo === "Por área" ? "areas" : "tags"}`}>
      <Typography variant="h6" sx={{ mb: 1.5 }}>
        {titulo}
      </Typography>
      {carregando && (!grupos || grupos.length === 0) ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }} data-testid="visoes-carregando">
          <CircularProgress size={24} />
          <Typography color="text.secondary">Carregando grupos...</Typography>
        </Stack>
      ) : !grupos || grupos.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="visoes-vazio">
          Nenhum grupo cadastrado.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {grupos.map((grupo) => (
            <Box
              key={grupo.id}
              component="button"
              type="button"
              onClick={() => abrirGrupo(campo, grupo)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                flexWrap: "wrap",
                width: "100%",
                textAlign: "left",
                p: 1.5,
                borderRadius: 2,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                cursor: "pointer",
                minHeight: 48,
                "&:hover": { bgcolor: "action.hover" },
                "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
              }}
              data-testid={`visoes-grupo-${campo}-${grupo.id}`}
            >
              <Typography variant="body1" fontWeight={600} sx={{ flexGrow: 1, minWidth: "40%", overflowWrap: "anywhere" }}>
                {grupo.nome}
              </Typography>
              <Chip label={`Pendentes: ${grupo.pendentes}`} size="small" variant="outlined" />
              <Chip
                label={`Vencidas: ${grupo.vencidas}`}
                size="small"
                variant={grupo.vencidas > 0 ? "filled" : "outlined"}
                color={grupo.vencidas > 0 ? "error" : "default"}
              />
              <Chip label={`Total: ${grupo.total}`} size="small" variant="outlined" />
              <ArrowForwardRounded fontSize="small" color="action" />
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  )

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Visões
        </Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshRounded />}
          onClick={() => void carregarResumo()}
          disabled={carregando}
          sx={{ minHeight: 44 }}
          data-testid="visoes-atualizar"
        >
          Atualizar
        </Button>
      </Stack>

      {erroCarga && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={tentarnovamente} sx={{ minHeight: 36 }}>
              Tentar novamente
            </Button>
          }
          data-testid="visoes-erro"
        >
          {erroCarga}
        </Alert>
      )}

      {/* Contagens são do servidor (resumo) — o front não recalcula. */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>{secaoGrupo("Por área", resumo?.areas, "areaId")}</Grid>
        <Grid size={{ xs: 12, md: 6 }}>{secaoGrupo("Por tag", resumo?.tags, "tagId")}</Grid>
      </Grid>
    </Stack>
  )
}
