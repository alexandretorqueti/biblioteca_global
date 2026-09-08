import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Alert, Box, Button, CircularProgress, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from "@mui/material"
import { SaveRounded } from "@mui/icons-material"
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

export default function ConfiguracoesScreen(): ReactNode {
  const api = useApi()
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
    <Box><Typography variant="h4" fontWeight={700}>Configurações</Typography><Typography color="text.secondary">Parâmetros operacionais usados pelo Motor. As alterações são aplicadas às próximas execuções.</Typography></Box>
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
  </Stack>
}
