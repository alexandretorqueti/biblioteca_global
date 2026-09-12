import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Alert, Box, Button, Chip, CircularProgress, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Paper, Select, Stack, Switch, Tab, Tabs, TextField, Typography } from "@mui/material"
import { AddRounded, ArrowDownwardRounded, ArrowUpwardRounded, DeleteRounded, SaveRounded } from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"

export const componentId = "gerenteagentes-configuracoes"

type Configuracao = {
  chave: string
  tipo: "number" | "string" | "boolean"
  valor: number | string | boolean
  valorPadrao: number | string | boolean
  regraValidacao: string
  descricao: string
  editavel: true
  atualizadoEm: string | null
}

function unidade(chave: string): string | undefined {
  return chave.endsWith("_ms") ? "ms" : chave.endsWith("_workers") || chave.endsWith("_per_project") ? "tarefas" : undefined
}

function limites(regra: string): { min?: number; max?: number } {
  const match = regra.match(/entre (\d+) e (\d+)/)
  return match ? { min: Number(match[1]), max: Number(match[2]) } : {}
}

/**
 * Configurações do Motor.
 *
 * Aba "Parâmetros": parâmetros operacionais do Motor (chave/valor).
 * Aba "MODELOS": configuração GLOBAL da fila de modelos — mesma estrutura da
 * tela de modelos do projeto, porém ao salvar propaga para todos os projetos.
 * A edição individual por projeto continua disponível na tela de cada projeto.
 */

// ── MODELOS (configuração global) ────────────────────────────────────────────

type ModelSelectionTipo = "DEV" | "ANALYST" | "MONITOR"

const MODEL_TIPOS: readonly ModelSelectionTipo[] = ["DEV", "ANALYST", "MONITOR"]

const TIPO_LABEL: Record<ModelSelectionTipo, string> = {
  DEV: "Dev (implementação)",
  ANALYST: "Analyst (análise)",
  MONITOR: "Monitor (acompanhamento)",
}

type ModelSelectionEntry = { ordem: number; provider: string; model: string; enabled: boolean }

type GlobalModelSelection = Record<ModelSelectionTipo, ModelSelectionEntry[]>

type EntradaEditavel = { provider: string; model: string; enabled: boolean }

type Filas = Record<ModelSelectionTipo, EntradaEditavel[]>

type ConsoleModelo = { id: string; name: string; provider: string; alias?: string }

type Propagacao = {
  configuracaoGlobal?: GlobalModelSelection
  resultadoPropagacao?: { sucesso: boolean; totalProjetos: number }
  projetosAplicados?: Array<{ projectKey: string; tipos: ModelSelectionTipo[] }>
  errosPorProjeto?: Array<{ projectKey: string; error: string }>
  mensagem?: string
}

const filasVazias = (): Filas => ({ DEV: [], ANALYST: [], MONITOR: [] })

function paraEditavel(config: GlobalModelSelection): Filas {
  const resultado = filasVazias()
  for (const tipo of MODEL_TIPOS) {
    resultado[tipo] = (config[tipo] ?? []).map(({ provider, model, enabled }) => ({ provider, model, enabled }))
  }
  return resultado
}

/** Providers distintos na ordem de aparição nos modelos do console. */
function providersDe(lista: ConsoleModelo[]): string[] {
  const vistos = new Set<string>()
  const ordenados: string[] = []
  for (const m of lista) {
    if (!m.provider || vistos.has(m.provider)) continue
    vistos.add(m.provider)
    ordenados.push(m.provider)
  }
  return ordenados
}

function GlobalModelSelectionPanel(): ReactNode {
  const api = useApi()
  const [tipo, setTipo] = useState<ModelSelectionTipo>("DEV")
  const [filas, setFilas] = useState<Filas>(filasVazias)
  const [modelos, setModelos] = useState<ConsoleModelo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Propagacao | null>(null)

  const carregar = useCallback(async () => {
    if (!api) return
    setLoading(true); setError(null)
    try {
      const [global, modelosRes] = await Promise.all([
        api.http.request<{ ok?: boolean; configuracaoGlobal?: GlobalModelSelection }>("GET", "/gerenteagentes/model-selection/global", { auth: "access" }),
        api.http.request<ConsoleModelo[] | { models?: ConsoleModelo[] }>("GET", "/gerenteagentes/modelos-console", { auth: "access" }).catch(() => [] as ConsoleModelo[]),
      ])
      if (!global.configuracaoGlobal) throw new Error("Resposta sem configuração global")
      setFilas(paraEditavel(global.configuracaoGlobal))
      setModelos(Array.isArray(modelosRes) ? modelosRes : (modelosRes.models ?? []))
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar modelos globais") }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void carregar() }, [carregar])

  const providers = useMemo(() => providersDe(modelos), [modelos])
  const modelosDoProvider = useCallback(
    (provider: string) => (provider ? modelos.filter((m) => m.provider === provider) : modelos),
    [modelos],
  )

  const atualizar = useCallback((index: number, patch: Partial<EntradaEditavel>) => {
    setFilas((atual) => ({ ...atual, [tipo]: atual[tipo].map((e, i) => (i === index ? { ...e, ...patch } : e)) }))
  }, [tipo])

  const adicionar = useCallback(() => {
    setFilas((atual) => ({ ...atual, [tipo]: [...atual[tipo], { provider: "", model: "", enabled: true }] }))
  }, [tipo])

  const remover = useCallback((index: number) => {
    setFilas((atual) => ({ ...atual, [tipo]: atual[tipo].filter((_, i) => i !== index) }))
  }, [tipo])

  const mover = useCallback((index: number, direcao: -1 | 1) => {
    setFilas((atual) => {
      const alvo = index + direcao
      if (alvo < 0 || alvo >= atual[tipo].length) return atual
      const copia = [...atual[tipo]]
      const item = copia[index]
      if (!item) return atual
      copia.splice(index, 1)
      copia.splice(alvo, 0, item)
      return { ...atual, [tipo]: copia }
    })
  }, [tipo])

  const aplicar = useCallback(async () => {
    if (!api) return
    if (MODEL_TIPOS.some((t) => filas[t].length === 0)) {
      setError("Cada tipo de agente (DEV, ANALYST, MONITOR) precisa ter ao menos um modelo.")
      return
    }
    if (MODEL_TIPOS.some((t) => filas[t].some((e) => !e.provider.trim() || !e.model.trim()))) {
      setError("Todas as entradas precisam de provider e model preenchidos.")
      return
    }
    setBusy(true); setError(null); setNotice(null); setResultado(null)
    try {
      const body = Object.fromEntries(
        MODEL_TIPOS.map((t) => [t, filas[t].map((e, i) => ({ ordem: i + 1, provider: e.provider.trim(), model: e.model.trim(), enabled: e.enabled }))]),
      ) as unknown as GlobalModelSelection
      const resposta = await api.http.request<Propagacao>("PUT", "/gerenteagentes/model-selection/global", { auth: "access", body })
      if (resposta.configuracaoGlobal) setFilas(paraEditavel(resposta.configuracaoGlobal))
      setResultado(resposta)
      const total = resposta.resultadoPropagacao?.totalProjetos ?? resposta.projetosAplicados?.length ?? 0
      setNotice(`${resposta.mensagem ?? "Configuração global salva."} ${total} projeto(s) aplicado(s).`.trim())
      if (resposta.errosPorProjeto?.length) setError(`A propagação falhou em ${resposta.errosPorProjeto.length} projeto(s).`)
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar configuração global") }
    finally { setBusy(false) }
  }, [api, filas])

  const entradas = filas[tipo]
  const podeAplicar = useMemo(
    () => !busy && MODEL_TIPOS.every((t) => filas[t].length > 0 && filas[t].every((e) => e.provider.trim() !== "" && e.model.trim() !== "")),
    [busy, filas],
  )

  if (loading) return <Box sx={{ display: "grid", placeItems: "center", minHeight: 200 }} data-testid="modelos-loading"><CircularProgress /></Box>

  return <Stack spacing={2} data-testid="configuracoes-modelos">
    <Box>
      <Typography variant="h6" fontWeight={700}>MODELOS</Typography>
      <Typography color="text.secondary">Configuração global da fila de modelos. Ao salvar, a alteração é propagada para todos os projetos. A edição individual de cada projeto continua disponível na tela do projeto.</Typography>
    </Box>
    {error && <Alert severity="error" data-testid="modelos-error">{error}</Alert>}
    {notice && <Alert severity="success" data-testid="modelos-success">{notice}</Alert>}

    <FormControl size="small" sx={{ minWidth: 320 }}>
      <InputLabel id="modelos-tipo-label">Tipo de agente</InputLabel>
      <Select
        labelId="modelos-tipo-label"
        label="Tipo de agente"
        value={tipo}
        onChange={(e) => setTipo(e.target.value as ModelSelectionTipo)}
        inputProps={{ "data-testid": "modelos-select-tipo", "aria-label": "tipo-agente" }}
      >
        {MODEL_TIPOS.map((t) => <MenuItem key={t} value={t} data-testid={`modelos-tipo-option-${t}`}>{TIPO_LABEL[t]}</MenuItem>)}
      </Select>
    </FormControl>

    {modelos.length === 0 && (
      <Alert severity="info" data-testid="modelos-no-console">Console OpenClaw indisponível — usando apenas os valores já salvos.</Alert>
    )}

    <Paper variant="outlined" sx={{ p: 2 }} data-testid="modelos-entries-panel">
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Modelos (1º = mais preferido)</Typography>
        <Button size="small" startIcon={<AddRounded />} onClick={adicionar} data-testid="modelos-btn-add">Adicionar modelo</Button>
      </Stack>

      {entradas.length === 0 && (
        <Alert severity="info" data-testid="modelos-empty">Nenhuma entrada. Clique em <b>Adicionar modelo</b> para montar a fila.</Alert>
      )}

      {entradas.map((entrada, i) => {
        const disponiveis = modelosDoProvider(entrada.provider)
        const providerLegado = !providers.includes(entrada.provider) ? entrada.provider : ""
        const modelLegado = !disponiveis.some((m) => m.id === entrada.model) ? entrada.model : ""
        return <Box
          key={i}
          data-testid={`modelos-entry-row-${i + 1}`}
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "auto 1fr 1.4fr auto auto auto auto" }, gap: 1.5, alignItems: "center", py: 1 }}
        >
          <Chip size="small" label={i + 1} color="primary" data-testid={`modelos-entry-order-${i + 1}`} />
          <FormControl size="small" sx={{ width: "100%" }}>
            <InputLabel id={`modelos-provider-label-${i + 1}`}>Provider</InputLabel>
            <Select
              labelId={`modelos-provider-label-${i + 1}`}
              label="Provider"
              value={entrada.provider}
              onChange={(e) => atualizar(i, { provider: e.target.value, model: "" })}
              inputProps={{ "data-testid": `modelos-entry-provider-${i + 1}`, "aria-label": `provider-${i + 1}` }}
            >
              {providerLegado && <MenuItem value={providerLegado}>{providerLegado} (legado)</MenuItem>}
              {providers.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ width: "100%" }}>
            <InputLabel id={`modelos-model-label-${i + 1}`}>Modelo</InputLabel>
            <Select
              labelId={`modelos-model-label-${i + 1}`}
              label="Modelo"
              value={entrada.model}
              onChange={(e) => atualizar(i, { model: e.target.value })}
              inputProps={{ "data-testid": `modelos-entry-model-${i + 1}`, "aria-label": `modelo-${i + 1}` }}
            >
              {modelLegado && <MenuItem value={modelLegado}>{modelLegado} (legado)</MenuItem>}
              {disponiveis.map((m) => <MenuItem key={m.id} value={m.id}>{m.name || m.id}</MenuItem>)}
            </Select>
          </FormControl>
          <Switch
            size="small"
            checked={entrada.enabled}
            onChange={(e) => atualizar(i, { enabled: e.target.checked })}
            inputProps={{ "aria-label": `enabled-${i + 1}` }}
          />
          <Button size="small" startIcon={<ArrowUpwardRounded />} disabled={i === 0} onClick={() => mover(i, -1)} data-testid={`modelos-entry-up-${i + 1}`}>Cima</Button>
          <Button size="small" startIcon={<ArrowDownwardRounded />} disabled={i === entradas.length - 1} onClick={() => mover(i, 1)} data-testid={`modelos-entry-down-${i + 1}`}>Baixo</Button>
          <Button size="small" color="error" startIcon={<DeleteRounded />} onClick={() => remover(i)} data-testid={`modelos-entry-remove-${i + 1}`}>Remover</Button>
        </Box>
      })}

      {entradas.length > 0 && <Divider sx={{ my: 2 }} />}
      <Stack direction="row" justifyContent="flex-end">
        <Button variant="contained" startIcon={<SaveRounded />} disabled={!podeAplicar} onClick={() => void aplicar()} data-testid="modelos-btn-apply">
          {busy ? "Aplicando..." : "Aplicar a todos os projetos"}
        </Button>
      </Stack>
    </Paper>

    {resultado && (
      <Paper variant="outlined" sx={{ p: 2 }} data-testid="modelos-propagation-result">
        <Typography variant="h6">Resultado da aplicação</Typography>
        <Typography data-testid="modelos-applied-count">{resultado.resultadoPropagacao?.totalProjetos ?? resultado.projetosAplicados?.length ?? 0} projeto(s) aplicado(s).</Typography>
        {resultado.projetosAplicados && resultado.projetosAplicados.length > 0 && (
          <Typography variant="body2" color="text.secondary">Projetos: {resultado.projetosAplicados.map((p) => p.projectKey).join(", ")}</Typography>
        )}
        {resultado.errosPorProjeto && resultado.errosPorProjeto.length > 0 && (
          <Stack spacing={0.5} sx={{ mt: 1 }} data-testid="modelos-project-errors">
            <Typography color="error" fontWeight={600}>Erros por projeto</Typography>
            {resultado.errosPorProjeto.map((item) => <Typography key={item.projectKey} variant="body2" color="error">{item.projectKey}: {item.error}</Typography>)}
          </Stack>
        )}
      </Paper>
    )}
  </Stack>
}

export default function ConfiguracoesScreen(): ReactNode {
  const api = useApi()
  const [aba, setAba] = useState<"parametros" | "modelos">("parametros")
  const [configuracoes, setConfiguracoes] = useState<Configuracao[]>([])
  const [valores, setValores] = useState<Record<string, number | string | boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    if (!api) return
    setLoading(true); setError(null)
    try {
      const resposta = await api.http.request<Configuracao[]>("GET", "/gerenteagentes/configuracoes", { auth: "access" })
      setConfiguracoes(resposta)
      setValores(Object.fromEntries(resposta.map((item) => [item.chave, item.valor])))
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar configurações") }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void carregar() }, [carregar])

  const atualizar = (config: Configuracao, raw: string | boolean) => {
    const valor = config.tipo === "number" ? (raw === "" ? "" : Number(raw)) : raw
    setValores((atual) => ({ ...atual, [config.chave]: valor }))
  }

  const salvar = async () => {
    if (!api) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const invalidos = configuracoes.filter((item) => {
        const valor = valores[item.chave]
        if (item.tipo === "boolean") return typeof valor !== "boolean"
        if (item.tipo !== "number") return typeof valor !== "string"
        const bounds = limites(item.regraValidacao)
        const numero = Number(valor)
        return valor === "" || !Number.isInteger(numero) || !Number.isFinite(numero) || (bounds.min !== undefined && numero < bounds.min) || (bounds.max !== undefined && numero > bounds.max)
      })
      if (invalidos.length) throw new Error(`Há valores inválidos. Confira tipo e limites: ${invalidos.map((item) => item.chave).join(", ")}`)
      const resposta = await api.http.request<Configuracao[]>("PUT", "/gerenteagentes/configuracoes", { auth: "access", body: { valores } })
      setConfiguracoes(resposta); setValores(Object.fromEntries(resposta.map((item) => [item.chave, item.valor])))
      setNotice("Configurações salvas com sucesso.")
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar configurações") }
    finally { setBusy(false) }
  }

  if (loading) return <Box sx={{ display: "grid", placeItems: "center", minHeight: 300 }} data-testid="configuracoes-loading"><CircularProgress /></Box>
  return <Stack spacing={2} data-testid="configuracoes-screen">
    <Box><Typography variant="h4" fontWeight={700}>Configurações</Typography><Typography color="text.secondary">Parâmetros operacionais usados pelo Motor e configuração global da fila de modelos.</Typography></Box>
    <Tabs value={aba} onChange={(_e, valor: "parametros" | "modelos") => setAba(valor)} data-testid="configuracoes-tabs">
      <Tab value="parametros" label="Parâmetros" data-testid="aba-parametros" />
      <Tab value="modelos" label="MODELOS" data-testid="aba-modelos" />
    </Tabs>

    {aba === "modelos" && <GlobalModelSelectionPanel />}

    {aba === "parametros" && <Stack spacing={2}>
      {error && <Alert severity="error" data-testid="configuracoes-error">{error}</Alert>}
      {notice && <Alert severity="success" data-testid="configuracoes-success">{notice}</Alert>}
      <Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={2}>
        {configuracoes.map((config) => {
          const bounds = limites(config.regraValidacao)
          const value = valores[config.chave]
          return <Box key={config.chave} data-testid={`configuracao-${config.chave}`} sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) 260px" }, alignItems: "center" }}>
            <Box><Typography fontWeight={600}>{config.chave}</Typography><Typography variant="body2" color="text.secondary">{config.descricao}</Typography><Typography variant="caption" color="text.secondary">Padrão: {String(config.valorPadrao)} · Regra: {config.regraValidacao}{unidade(config.chave) ? ` · Unidade: ${unidade(config.chave)}` : ""}</Typography></Box>
            {config.tipo === "boolean" ? <FormControlLabel control={<Switch data-testid={`config-input-${config.chave}`} checked={value === true} onChange={(event) => atualizar(config, event.target.checked)} disabled={!config.editavel || busy} />} label={value === true ? "Ativado" : "Desativado"} /> : <TextField data-testid={`config-input-${config.chave}`} label="Valor atual" type={config.tipo === "number" ? "number" : "text"} value={value ?? ""} onChange={(event) => atualizar(config, event.target.value)} inputProps={{ min: bounds.min, max: bounds.max, step: config.tipo === "number" ? 1 : undefined }} disabled={!config.editavel || busy} fullWidth />}
          </Box>
        })}
        <Button variant="contained" startIcon={<SaveRounded />} onClick={() => void salvar()} disabled={busy || configuracoes.length === 0} data-testid="configuracoes-save">Salvar configurações</Button>
      </Stack></Paper>
    </Stack>}
  </Stack>
}
