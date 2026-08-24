/**
 * ModelSelectionScreen — fila de modelos de IA por projeto e tipo de agente
 * (task-54; combos de provider/modelo no console em task-66/st-2).
 * Reproduz, dentro da biblioteca, a tela do motor que edita a tabela
 * `project_model_selection`.
 *
 * - Seletor de tipo (DEV / ANALYST / MONITOR)
 * - Ao montar, busca `GET /gerenteagentes/modelos-console` (proxy p/ Console
 *   OpenClaw) e popula os combos de provider/modelo de cada entrada.
 * - Lista editável de entradas: ordem, provider (combo), model (combo
 *   filtrado pelo provider), enabled
 * - Entradas já salvas com valores legados (fora da lista do console)
 *   continuam editáveis: o valor atual aparece como opção extra no combo.
 * - Botões: adicionar / remover / reordenar (acima / abaixo)
 * - Salvar via api-client → PUT /gerenteagentes/model-selection/:projectKey/:tipo
 *   (proxy p/ motor). O `projectKey` é o slug do projeto da linha pai
 *   clicada na childRoute (props.parentRow.slug); se a tela for aberta sem
 *   contexto de linha (menu direto), usa o slug do projeto logado.
 *
 * A UI não fala HTTP diretamente — tudo passa pelo api-client (regra do projeto).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material"
import {
  AddRounded,
  ArrowUpwardRounded,
  ArrowDownwardRounded,
  DeleteRounded,
  SaveRounded,
} from "@mui/icons-material"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import { useAuth } from "../../../apps/web/src/auth/AuthContext"
import type { CustomScreenProps } from "@biblioteca-global/ui"
import type { ModelSelectionTipo, ModelSelectionEntry } from "@biblioteca-global/shared"

const TIPOS: ModelSelectionTipo[] = ["DEV", "ANALYST", "MONITOR"]

/** Rótulos amigáveis por tipo de agente. */
const TIPO_LABEL: Record<ModelSelectionTipo, string> = {
  DEV: "Dev (implementação)",
  ANALYST: "Analyst (análise)",
  MONITOR: "Monitor (acompanhamento)",
}

type ConsoleModelo = { id: string; name: string; provider: string; alias?: string }

type EntradaEditavel = {
  provider: string
  model: string
  enabled: boolean
}

/** Providers distintos na ordem de aparição. */
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

export default function ModelSelectionScreen(props: CustomScreenProps): ReactNode {
  const bundle = useApi()
  const auth = useAuth()
  // projectKey = slug do projeto da linha clicada (childRoute). Sem contexto
  // de linha (abertura direta por menu), cai no slug do projeto logado.
  const linha = props.parentRow
  const slugDaLinha =
    linha && typeof linha.slug === "string" && linha.slug.trim() !== ""
      ? linha.slug.trim()
      : undefined
  const projectKey = slugDaLinha ?? auth.projeto?.slug ?? ""
  const nomeDaLinha =
    linha && typeof linha.nome === "string" && linha.nome.trim() !== ""
      ? linha.nome.trim()
      : undefined

  const [tipo, setTipo] = useState<ModelSelectionTipo>("DEV")
  const [entradas, setEntradas] = useState<EntradaEditavel[]>([])
  const [modelos, setModelos] = useState<ConsoleModelo[]>([])
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const mounted = useRef(true)

  const carregar = useCallback(async (tipoSel: ModelSelectionTipo) => {
    if (!bundle) return
    setLoading(true)
    setErro(null)
    try {
      const [res, modelosRes] = await Promise.all([
        bundle.http.request<{ projectKey?: string; tipo?: string; entries?: ModelSelectionEntry[] }>(
          "GET",
          `/gerenteagentes/model-selection/${encodeURIComponent(projectKey)}/${tipoSel}`,
          { auth: "access" },
        ),
        bundle
          .http.request<ConsoleModelo[] | { models?: ConsoleModelo[] }>("GET", "/gerenteagentes/modelos-console", { auth: "access" })
          .catch(() => [] as ConsoleModelo[]),
      ])
      const lista = (res.entries ?? []).map((e) => ({
        provider: e.provider,
        model: e.model,
        enabled: e.enabled,
      }))
      const listaModelos = Array.isArray(modelosRes)
        ? modelosRes
        : ((modelosRes as { models?: ConsoleModelo[] }).models ?? [])
      if (mounted.current) {
        setEntradas(lista)
        setModelos(listaModelos)
      }
    } catch (e) {
      if (mounted.current) setErro(e instanceof Error ? e.message : "Erro ao carregar seleção de modelos")
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [bundle, projectKey])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Recarrega ao trocar o tipo.
  useEffect(() => {
    void carregar(tipo)
  }, [tipo, carregar])

  const providers = useMemo(() => providersDe(modelos), [modelos])

  /** Modelos do provider selecionado; provider vazio → todos. */
  const modelosDoProvider = useCallback(
    (provider: string) => (provider ? modelos.filter((m) => m.provider === provider) : modelos),
    [modelos],
  )

  const atualizarEntrada = useCallback((index: number, patch: Partial<EntradaEditavel>) => {
    setEntradas((atual) => atual.map((e, i) => (i === index ? { ...e, ...patch } : e)))
  }, [])

  const adicionarEntrada = useCallback(() => {
    setEntradas((atual) => [...atual, { provider: "", model: "", enabled: true }])
  }, [])

  const removerEntrada = useCallback((index: number) => {
    setEntradas((atual) => atual.filter((_, i) => i !== index))
  }, [])

  const mover = useCallback((index: number, direcao: -1 | 1) => {
    setEntradas((atual) => {
      const alvo = index + direcao
      if (alvo < 0 || alvo >= atual.length) return atual
      const copia = [...atual]
      const item = copia[index]
      if (!item) return atual
      copia.splice(index, 1)
      copia.splice(alvo, 0, item)
      return copia
    })
  }, [])

  const salvar = useCallback(async () => {
    if (!bundle) return
    // Validar localmente: provider e model não vazios, e ao menos uma entrada.
    if (entradas.length === 0) {
      setErro("Adicione pelo menos um modelo antes de salvar.")
      return
    }
    if (entradas.some((e) => !e.provider.trim() || !e.model.trim())) {
      setErro("Todas as entradas precisam de provider e model preenchidos.")
      return
    }
    setSalvando(true)
    setErro(null)
    setAviso(null)
    try {
      const payload: ModelSelectionEntry[] = entradas.map((e, i) => ({
        ordem: i + 1,
        provider: e.provider.trim(),
        model: e.model.trim(),
        enabled: e.enabled,
      }))
      const resposta = await bundle.http.request<{ projectKey?: string; tipo?: string; entries?: ModelSelectionEntry[] }>(
        "PUT",
        `/gerenteagentes/model-selection/${encodeURIComponent(projectKey)}/${tipo}`,
        { auth: "access", body: { entries: payload } },
      )
      // Recarrega a resposta do motor para refletir o estado salvo.
      const entradasSalvas = (resposta.entries ?? payload).map((e) => ({
        provider: e.provider,
        model: e.model,
        enabled: e.enabled,
      }))
      setEntradas(entradasSalvas)
      if (mounted.current) setAviso("Seleção de modelos salva.")
    } catch (e) {
      if (mounted.current) setErro(e instanceof Error ? e.message : "Erro ao salvar seleção de modelos")
    } finally {
      if (mounted.current) setSalvando(false)
    }
  }, [bundle, projectKey, tipo, entradas])

  const podeSalvar = useMemo(
    () =>
      !salvando &&
      entradas.length > 0 &&
      entradas.every((e) => e.provider.trim() !== "" && e.model.trim() !== ""),
    [entradas, salvando],
  )

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }} data-testid="loading-spinner">
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Stack spacing={3} data-testid="model-selection-screen">
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems="center">
        <Typography variant="h4" fontWeight={600}>
          Fila de Modelos
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Projeto: {nomeDaLinha ? `${nomeDaLinha} (${projectKey})` : projectKey || "—"}
        </Typography>
      </Stack>

      {erro && <Alert severity="error" data-testid="error-alert">{erro}</Alert>}
      {aviso && !erro && <Alert severity="success" data-testid="success-alert">{aviso}</Alert>}

      <FormControl size="small" sx={{ minWidth: 320 }}>
        <InputLabel id="select-tipo-label">Tipo de agente</InputLabel>
        <Select
          labelId="select-tipo-label"
          label="Tipo de agente"
          value={tipo}
          onChange={(e) => setTipo(e.target.value as ModelSelectionTipo)}
          inputProps={{ "data-testid": "select-tipo", "aria-label": "tipo-agente" }}
        >
          {TIPOS.map((t) => (
            <MenuItem key={t} value={t} data-testid={`tipo-option-${t}`}>
              {TIPO_LABEL[t]}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {modelos.length === 0 && (
        <Alert severity="info" data-testid="no-console-models">
          Console OpenClaw indisponível — usando apenas os valores já salvos.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }} data-testid="entries-panel">
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">Modelos (1º = mais preferido)</Typography>
          <Button
            size="small"
            startIcon={<AddRounded />}
            onClick={adicionarEntrada}
            data-testid="btn-add"
          >
            Adicionar modelo
          </Button>
        </Stack>

        {entradas.length === 0 && (
          <Alert severity="info" data-testid="empty-state">
            Nenhuma entrada. Clique em <b>Adicionar modelo</b> para montar a fila.
          </Alert>
        )}

        {entradas.map((entrada, i) => {
          // Fallback: valor legado salvo que não está na lista do console
          // continua editável — vira opção extra no fim do combo.
          const modelosEntrada = modelosDoProvider(entrada.provider)
          const providerLegado = !providers.includes(entrada.provider) ? entrada.provider : ""
          const modelLegado = !modelosEntrada.some((m) => m.id === entrada.model) ? entrada.model : ""
          return (
            <Box
              key={i}
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "auto 1fr 1.4fr auto auto auto auto" },
                gap: 1.5,
                alignItems: "center",
                py: 1,
              }}
              data-testid={`entry-row-${i + 1}`}
            >
              <Chip size="small" label={i + 1} color="primary" data-testid={`entry-order-${i + 1}`} />
              <FormControl size="small" sx={{ width: "100%" }}>
                <InputLabel id={`provider-label-${i + 1}`}>Provider</InputLabel>
                <Select
                  labelId={`provider-label-${i + 1}`}
                  label="Provider"
                  value={entrada.provider}
                  onChange={(ev) => {
                    // Trocar o provider zera o model (o combo é encadeado).
                    atualizarEntrada(i, { provider: ev.target.value, model: "" })
                  }}
                  inputProps={{ "data-testid": `entry-provider-${i + 1}`, "aria-label": `provider-${i + 1}` }}
                >
                  {providerLegado && (
                    <MenuItem key={`legado-${providerLegado}`} value={providerLegado}>
                      {providerLegado} (legado)
                    </MenuItem>
                  )}
                  {providers.map((p) => (
                    <MenuItem key={p} value={p}>
                      {p}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ width: "100%" }}>
                <InputLabel id={`model-label-${i + 1}`}>Modelo</InputLabel>
                <Select
                  labelId={`model-label-${i + 1}`}
                  label="Modelo"
                  value={entrada.model}
                  onChange={(ev) => atualizarEntrada(i, { model: ev.target.value })}
                  inputProps={{ "data-testid": `entry-model-${i + 1}`, "aria-label": `modelo-${i + 1}` }}
                >
                  {modelLegado && (
                    <MenuItem key={`legado-${modelLegado}`} value={modelLegado}>
                      {modelLegado} (legado)
                    </MenuItem>
                  )}
                  {modelosEntrada.map((m) => (
                    <MenuItem key={m.id} value={m.id}>
                      {m.name || m.id}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Switch
                size="small"
                checked={entrada.enabled}
                onChange={(ev) => atualizarEntrada(i, { enabled: ev.target.checked })}
                inputProps={{ "aria-label": `enabled-${i + 1}` }}
              />
              <Button
                size="small"
                startIcon={<ArrowUpwardRounded />}
                disabled={i === 0}
                onClick={() => mover(i, -1)}
                aria-label="mover-para-cima"
                data-testid={`entry-up-${i + 1}`}
              >
                Cima
              </Button>
              <Button
                size="small"
                startIcon={<ArrowDownwardRounded />}
                disabled={i === entradas.length - 1}
                onClick={() => mover(i, 1)}
                aria-label="mover-para-baixo"
                data-testid={`entry-down-${i + 1}`}
              >
                Baixo
              </Button>
              <Button
                size="small"
                color="error"
                startIcon={<DeleteRounded />}
                onClick={() => removerEntrada(i)}
                aria-label="remover"
                data-testid={`entry-remove-${i + 1}`}
              >
                Remover
              </Button>
            </Box>
          )
        })}

        {entradas.length > 0 && <Divider sx={{ my: 2 }} />}

        {entradas.length > 0 && (
          <Stack direction="row" justifyContent="flex-end">
            <Button
              variant="contained"
              startIcon={<SaveRounded />}
              disabled={!podeSalvar}
              onClick={() => void salvar()}
              data-testid="btn-save"
            >
              {salvando ? "Salvando..." : "Salvar"}
            </Button>
          </Stack>
        )}
      </Paper>
    </Stack>
  )
}
