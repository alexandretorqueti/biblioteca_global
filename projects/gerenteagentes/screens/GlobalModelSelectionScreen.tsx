/** Edição das filas globais de modelos, propagadas para todos os projetos. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Alert, Box, Button, Chip, CircularProgress, Divider, FormControl, InputLabel, MenuItem, Paper, Select, Stack, Switch, Typography } from "@mui/material"
import { AddRounded, ArrowDownwardRounded, ArrowUpwardRounded, DeleteRounded, SaveRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import type { CustomScreenProps } from "@biblioteca-global/ui"
import { GLOBAL_MODEL_SELECTION_TYPES, type GlobalModelSelection, type GlobalModelSelectionEntry, type GlobalModelSelectionTipo, type GlobalModelSelectionPropagationResponse } from "../motor-v2/src/shared/global-model-selection"

export const componentId = "gerenteagentes-global-model-selection"
type ConsoleModelo = { id: string; name: string; provider: string; alias?: string }
type EntradaEditavel = Omit<GlobalModelSelectionEntry, "ordem">
type Filas = Record<GlobalModelSelectionTipo, EntradaEditavel[]>

const TIPO_LABEL: Record<GlobalModelSelectionTipo, string> = { DEV: "Dev (implementação)", ANALYST: "Analyst (análise)", MONITOR: "Monitor (acompanhamento)" }
const vazias = (): Filas => ({ DEV: [], ANALYST: [], MONITOR: [] })
const paraEditavel = (config: GlobalModelSelection): Filas => Object.fromEntries(
  GLOBAL_MODEL_SELECTION_TYPES.map((tipo) => [tipo, (config[tipo] ?? []).map(({ provider, model, enabled }) => ({ provider, model, enabled }))]),
) as Filas

export default function GlobalModelSelectionScreen(_props: CustomScreenProps): ReactNode {
  const api = useApi()
  const [tipo, setTipo] = useState<GlobalModelSelectionTipo>("DEV")
  const [filas, setFilas] = useState<Filas>(vazias)
  const [modelos, setModelos] = useState<ConsoleModelo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [resultado, setResultado] = useState<GlobalModelSelectionPropagationResponse | null>(null)
  const mounted = useRef(true)
  const entradas = filas[tipo]
  const providers = useMemo(() => [...new Set(modelos.map((m) => m.provider).filter(Boolean))], [modelos])

  const carregar = useCallback(async () => {
    if (!api) return
    setLoading(true); setErro(null)
    try {
      const [global, modelosRes] = await Promise.all([
        api.http.request<{ configuracaoGlobal?: GlobalModelSelection }>("GET", "/gerenteagentes/model-selection/global", { auth: "access" }),
        api.http.request<ConsoleModelo[] | { models?: ConsoleModelo[] }>("GET", "/gerenteagentes/modelos-console", { auth: "access" }).catch(() => [] as ConsoleModelo[]),
      ])
      if (!global.configuracaoGlobal) throw new Error("Resposta sem configuração global")
      if (mounted.current) {
        setFilas(paraEditavel(global.configuracaoGlobal))
        setModelos(Array.isArray(modelosRes) ? modelosRes : (modelosRes.models ?? []))
      }
    } catch (e) { if (mounted.current) setErro(e instanceof Error ? e.message : "Erro ao carregar seleção global de modelos") }
    finally { if (mounted.current) setLoading(false) }
  }, [api])

  useEffect(() => { mounted.current = true; void carregar(); return () => { mounted.current = false } }, [carregar])
  const modelosDoProvider = useCallback((provider: string) => provider ? modelos.filter((m) => m.provider === provider) : modelos, [modelos])
  const atualizar = useCallback((index: number, patch: Partial<EntradaEditavel>) => setFilas((atual) => ({ ...atual, [tipo]: atual[tipo].map((e, i) => i === index ? { ...e, ...patch } : e) })), [tipo])
  const adicionar = () => setFilas((atual) => ({ ...atual, [tipo]: [...atual[tipo], { provider: "", model: "", enabled: true }] }))
  const remover = (index: number) => setFilas((atual) => ({ ...atual, [tipo]: atual[tipo].filter((_, i) => i !== index) }))
  const mover = (index: number, direcao: -1 | 1) => setFilas((atual) => {
    const alvo = index + direcao; if (alvo < 0 || alvo >= atual[tipo].length) return atual
    const copia = [...atual[tipo]]; const [item] = copia.splice(index, 1); if (item) copia.splice(alvo, 0, item)
    return { ...atual, [tipo]: copia }
  })

  const aplicar = async () => {
    if (!api) return
    if (GLOBAL_MODEL_SELECTION_TYPES.some((t) => filas[t].length === 0)) { setErro("Cada tipo de agente precisa ter pelo menos um modelo."); return }
    if (GLOBAL_MODEL_SELECTION_TYPES.some((t) => filas[t].some((e) => !e.provider.trim() || !e.model.trim()))) { setErro("Todas as entradas precisam de provider e model preenchidos."); return }
    setBusy(true); setErro(null); setAviso(null); setResultado(null)
    try {
      const config = Object.fromEntries(GLOBAL_MODEL_SELECTION_TYPES.map((t) => [t, filas[t].map((e, i) => ({ ...e, provider: e.provider.trim(), model: e.model.trim(), ordem: i + 1 }))])) as GlobalModelSelection
      const resposta = await api.http.request<GlobalModelSelectionPropagationResponse & { mensagem?: string }>("PUT", "/gerenteagentes/model-selection/global", { auth: "access", body: config })
      if (resposta.configuracaoGlobal) setFilas(paraEditavel(resposta.configuracaoGlobal))
      setResultado(resposta)
      const total = resposta.resultadoPropagacao?.totalProjetos ?? resposta.projetosAplicados?.length ?? 0
      setAviso(`${resposta.mensagem ?? "Configuração global aplicada com sucesso."} ${total} projeto(s) aplicado(s).`)
      if (resposta.errosPorProjeto?.length) setErro(`Erros em ${resposta.errosPorProjeto.length} projeto(s).`)
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao aplicar configuração global") }
    finally { setBusy(false) }
  }

  const podeAplicar = !busy && GLOBAL_MODEL_SELECTION_TYPES.every((t) => filas[t].length > 0 && filas[t].every((e) => e.provider.trim() && e.model.trim()))
  if (loading) return <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="global-model-selection-loading"><CircularProgress /></Box>
  return <Stack spacing={3} data-testid="global-model-selection-screen">
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="center"><Typography variant="h4" fontWeight={600}>Modelos Globais</Typography><Typography variant="caption" color="text.secondary">Configuração global — aplica a todos os projetos</Typography></Stack>
    {erro && <Alert severity="error" data-testid="global-model-selection-error">{erro}</Alert>}
    {aviso && <Alert severity="success" data-testid="global-model-selection-success">{aviso}</Alert>}
    <FormControl size="small" sx={{ minWidth: 320 }}><InputLabel id="global-select-tipo-label">Tipo de agente</InputLabel><Select labelId="global-select-tipo-label" label="Tipo de agente" value={tipo} onChange={(e) => setTipo(e.target.value as GlobalModelSelectionTipo)} inputProps={{ "data-testid": "global-select-tipo" }}>{GLOBAL_MODEL_SELECTION_TYPES.map((t) => <MenuItem key={t} value={t}>{TIPO_LABEL[t]}</MenuItem>)}</Select></FormControl>
    {modelos.length === 0 && <Alert severity="info">Console OpenClaw indisponível — usando apenas os valores já salvos.</Alert>}
    <Paper variant="outlined" sx={{ p: 2 }} data-testid="global-entries-panel">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}><Typography variant="h6">Modelos (1º = mais preferido)</Typography><Button size="small" startIcon={<AddRounded />} onClick={adicionar} data-testid="global-btn-add">Adicionar modelo</Button></Stack>
      {entradas.length === 0 && <Alert severity="info">Nenhuma entrada. Clique em <b>Adicionar modelo</b> para montar a fila.</Alert>}
      {entradas.map((entrada, i) => {
        const disponiveis = modelosDoProvider(entrada.provider)
        const providerLegado = !providers.includes(entrada.provider) ? entrada.provider : ""
        const modelLegado = !disponiveis.some((m) => m.id === entrada.model) ? entrada.model : ""
        return <Box key={i} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "auto 1fr 1.4fr auto auto auto auto" }, gap: 1.5, alignItems: "center", py: 1 }} data-testid={`global-entry-row-${i + 1}`}>
          <Chip size="small" label={i + 1} color="primary" />
          <FormControl size="small"><InputLabel>Provider</InputLabel><Select label="Provider" value={entrada.provider} onChange={(e) => atualizar(i, { provider: e.target.value, model: "" })} inputProps={{ "data-testid": `global-entry-provider-${i + 1}` }}>{providerLegado && <MenuItem value={providerLegado}>{providerLegado} (legado)</MenuItem>}{providers.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}</Select></FormControl>
          <FormControl size="small"><InputLabel>Modelo</InputLabel><Select label="Modelo" value={entrada.model} onChange={(e) => atualizar(i, { model: e.target.value })} inputProps={{ "data-testid": `global-entry-model-${i + 1}` }}>{modelLegado && <MenuItem value={modelLegado}>{modelLegado} (legado)</MenuItem>}{disponiveis.map((m) => <MenuItem key={m.id} value={m.id}>{m.name || m.id}</MenuItem>)}</Select></FormControl>
          <Switch size="small" checked={entrada.enabled} onChange={(e) => atualizar(i, { enabled: e.target.checked })} inputProps={{ "aria-label": `global-enabled-${i + 1}` }} />
          <Button size="small" startIcon={<ArrowUpwardRounded />} disabled={i === 0} onClick={() => mover(i, -1)}>Cima</Button><Button size="small" startIcon={<ArrowDownwardRounded />} disabled={i === entradas.length - 1} onClick={() => mover(i, 1)}>Baixo</Button><Button size="small" color="error" startIcon={<DeleteRounded />} onClick={() => remover(i)}>Remover</Button>
        </Box>
      })}
      {entradas.length > 0 && <Divider sx={{ my: 2 }} />}
      <Stack direction="row" justifyContent="flex-end"><Button variant="contained" startIcon={<SaveRounded />} disabled={!podeAplicar} onClick={() => void aplicar()} data-testid="global-btn-apply">{busy ? "Aplicando..." : "Aplicar mudanças"}</Button></Stack>
    </Paper>
    {resultado && <Paper variant="outlined" sx={{ p: 2 }} data-testid="global-propagation-result"><Typography variant="h6">Resultado da aplicação</Typography><Typography data-testid="global-applied-count">{resultado.resultadoPropagacao.totalProjetos} projeto(s) aplicado(s).</Typography>{resultado.projetosAplicados.length > 0 && <Typography variant="body2" color="text.secondary">Projetos: {resultado.projetosAplicados.map((projeto) => projeto.projectKey).join(", ")}</Typography>}{resultado.errosPorProjeto.length > 0 && <Stack spacing={0.5} sx={{ mt: 1 }} data-testid="global-project-errors"><Typography color="error" fontWeight={600}>Erros por projeto</Typography>{resultado.errosPorProjeto.map((item) => <Typography key={item.projectKey} variant="body2" color="error">{item.projectKey}: {item.error}</Typography>)}</Stack>}</Paper>}
  </Stack>
}
